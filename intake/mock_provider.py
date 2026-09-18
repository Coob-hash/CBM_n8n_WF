"""Disposable local provider simulator. Never deployed in the application image."""
import io
import uuid
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from PIL import Image
from PIL.TiffImagePlugin import IFDRational
app=FastAPI()
messages=[]
RAD='3kcZF9AH16IwPfuL_CGFlR'
OUT='1qMgWWNHzE3egAZbWFbgXF'

@app.get('/photo')
def photo():
    image=Image.new('RGB',(640,480),'#557766');exif=Image.Exif()
    exif[271]='Apple';exif[272]='iPhone 16';exif[274]=1;exif[41989]=26;exif[37386]=IFDRational(596,100)
    buf=io.BytesIO();image.save(buf,format='JPEG',exif=exif)
    return Response(buf.getvalue(),media_type='image/jpeg')
@app.post('/token')
def token():return {'token':'isolated-validation-only'}
@app.post('/localize')
def localize(file:str):
    if file.startswith('error'):raise HTTPException(503,'Simulated provider outage')
    return {'poseFound':not file.startswith('bad'),'confidence':0.95,'position':{'x':0,'y':0,'z':0},'mapCodes':['MAP_J964JX6MGEGO']}
@app.post('/resolve')
def resolve():
    return {'found':False,'reason':'AUTOMATIC_IDENTIFICATION_REQUIRED','candidates':[
     {'global_id':RAD,'ifc_class':'IfcBuildingElementProxy','name':'Fondital radiator','camera_distance_m':1.1},
     {'global_id':OUT,'ifc_class':'IfcBuildingElementProxy','name':'Electrical outlet','camera_distance_m':1.2}]}
@app.post('/vision')
def vision(file:str):
    import json
    ambiguous=file.startswith('ambiguous')
    result={'identified':not ambiguous,'ambiguous':ambiguous,'global_id':OUT if 'outlet' in file else RAD,
    'identification_confidence':0.96,'identification_evidence':'Simulated target evidence, only for isolated branch validation',
    'category':'electrical' if 'outlet' in file else 'heating','severity':3,
    'description':'Simulated issue <img src=x onerror=alert(1)>','required_skill':'electrical' if 'outlet' in file else 'hvac'}
    if file.startswith('invented'):result['global_id']='0000000000000000000000'
    return {'content':[{'type':'text','text':json.dumps(result)}]}
@app.post('/send')
async def send(request:Request):
    messages.append(await request.json());return {'id':'mock-'+str(uuid.uuid4())}
@app.get('/messages')
def sent():return messages
