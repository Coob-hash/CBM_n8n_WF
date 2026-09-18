"""Start both real Uvicorn services on loopback with a temporary synthetic model."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import threading
import uvicorn
import urllib.error
import urllib.request
import base64
import io
from PIL import Image
import ifcopenshell

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

def request(url,data=None,headers=None):
    req=urllib.request.Request(url,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json',**(headers or {})})
    with urllib.request.urlopen(req,timeout=5) as res:return json.load(res)

with tempfile.TemporaryDirectory(prefix='cbm-http-smoke-') as tmp:
    folder=Path(tmp)
    subprocess.run([sys.executable,str(ROOT/'create_sample_ifc.py')],cwd=folder,check=True,capture_output=True)
    gid=ifcopenshell.open(str(folder/'models/room_v1.ifc')).by_type('IfcSpaceHeater')[0].GlobalId
    (folder/'documents').mkdir();(folder/'documents/synthetic.txt').write_text('SYNTHETIC TEST ONLY. Inspect the radiator valve before servicing. Document the completed repair.')
    (folder/'catalog.json').write_text(json.dumps({'approved':True,'products':[{'id':'test','manufacturer':'Synthetic','model':'Test','documents':[{'approved':True,'id':'text','title':'Synthetic text','revision':'1','path':'synthetic.txt'}]}],
        'assets':[{'global_id':gid,'product_id':'test','ifc_class':'IfcSpaceHeater','ifc_type_global_id':None}]}))
    os.environ.update(IFC_MODEL_DIR=str(folder/'models'),CBM_KNOWLEDGE_CATALOG=str(folder/'catalog.json'),CBM_KNOWLEDGE_KEY='test-only-local-smoke')
    import ifc_service
    from knowledge.service import app as knowledge_app
    servers=[];threads=[]
    try:
        urls=[]
        for app in [ifc_service.app,knowledge_app]:
            endpoint=port();server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=endpoint,log_level='warning'))
            thread=threading.Thread(target=server.run,daemon=True);thread.start()
            servers.append(server);threads.append(thread);urls.append(f'http://127.0.0.1:{endpoint}')
        for server in servers:
            deadline=time.monotonic()+15
            while not server.started and time.monotonic()<deadline:time.sleep(.05)
            if not server.started:raise RuntimeError('Service readiness timeout')
        assert request(urls[0]+'/health')['maintainable_elements']==4
        print('PASS Real HTTP IFC /health')
        buf=io.BytesIO();exif=Image.Exif();exif[41989]=26;Image.new('RGB',(1600,1200),'white').save(buf,format='JPEG',exif=exif)
        capture=request(urls[0]+'/captures/normalize',{'imageB64':base64.b64encode(buf.getvalue()).decode()})
        assert capture['camera']['trusted']
        print('PASS Real HTTP /captures/normalize with EXIF fixture')
        result=request(urls[1]+'/knowledge/snapshot',headers={'X-CBM-Knowledge-Key':'test-only-local-smoke'})
        assert result['chunks'] and result['chunks'][0]['metadata']['ifc_global_id']==gid
        print('PASS Real HTTP /knowledge/snapshot with synthetic TXT')
    finally:
        for server in servers:server.should_exit=True
        for thread in threads:
            thread.join(10)
            if thread.is_alive():raise RuntimeError('Test HTTP service did not stop')
