"""Import the supplied office IFC once; never generate or overwrite a model."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import ifcopenshell
from service_lock import atomic_text, model_lock

def initialize():
    case = Path(os.environ.get('CBM_CASE_STUDY_DIR', '/app/case-study'))
    models = Path(os.environ.get('IFC_MODEL_DIR', '/app/models'))
    profile = json.loads((case / 'profile.json').read_text(encoding='utf-8'))
    source = (case / profile['ifc_source']).resolve()
    if not source.is_relative_to(case.resolve()) or not source.is_file():
        raise RuntimeError('Case-study IFC source is missing or outside its directory')
    if hashlib.sha256(source.read_bytes()).hexdigest() != profile['ifc_source_sha256']:
        raise RuntimeError('Case-study IFC does not match its reviewed source hash')
    models.mkdir(parents=True, exist_ok=True)
    with model_lock(models):
        pointer, origin = models/'active_model.txt', models/'model_origin.json'
        if pointer.exists():
            active = (models/pointer.read_text().strip()).resolve()
            if not active.is_relative_to(models.resolve()) or not active.is_file():
                raise RuntimeError('Invalid active model pointer; repair existing lineage')
            saved = json.loads(origin.read_text()) if origin.is_file() else {}
            if saved.get('source_sha256') != profile['ifc_source_sha256']:
                raise RuntimeError('Existing volume belongs to another model; preserve it and use the case-study volume')
            print('Existing case-study model preserved:', active.name)
            return
        if any(models.glob('*.ifc')) or origin.exists() or (models/'maintenance_audit.jsonl').exists():
            raise RuntimeError('Existing lineage has no active pointer; refusing to overwrite it')
        model = ifcopenshell.open(str(source))
        for gid in profile['primary_targets'].values():
            model.by_guid(gid)
        name = profile['ifc_initial_name']
        if Path(name).name != name or not name.endswith('.ifc'):
            raise RuntimeError('Invalid initial IFC filename')
        temporary = models/(name+'.importing')
        shutil.copyfile(source, temporary)
        temporary.replace(models/name)
        atomic_text(origin, json.dumps({'case_id':profile['case_id'], 'source_sha256':profile['ifc_source_sha256'],
            'source_name':source.name, 'schema':model.schema}, indent=2))
        atomic_text(pointer, name)
        print('Imported original office IFC without changing its contents:', name)

if __name__ == '__main__':
    initialize()
