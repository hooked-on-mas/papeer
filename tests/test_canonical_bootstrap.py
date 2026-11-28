import json
from pathlib import Path
from copy import deepcopy
import pytest
from papeer.core.bootstrap.canonical_bootstrap import admit_initial_library, assert_initialization_unchanged, assert_canonical_profile
from papeer.core.edit_contracts import validate_canonicallibraryprofile, validate_canonicaldevicepeer
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_model import canonical_json
from papeer.core.edits.dataset_control import assert_dataset_control_transition

F = json.loads((Path(__file__).parent / 'fixtures/canonical-bootstrap.json').read_text(encoding='utf8'))
OLD = json.loads((Path(__file__).parent / 'fixtures/shared-edits.json').read_text(encoding='utf8'))

def setup_case():
    profile, peer = deepcopy(F['profile']), deepcopy(F['peer']); profile.pop('initialization'); profile.pop('origin')
    library = profile['identity']['libraryId']
    checkpoint = {'version':1,'libraryId':library,'roots':[{'kind':'library','id':library,'version':F['rootVersion'],'items':[],'folders':[],'links':[],'deletions':[]}],'edits':[]}
    manifest = {'version':1,'id':F['manifestId'],'scope':{**profile['identity'],'epoch':F['epoch']},'checkpointSha256':checkpoint_hash(checkpoint),'resources':[]}
    control = {'version':1,'id':F['requestId'],'identity':profile['identity'],'epochs':[F['epoch']],'active':manifest,'transition':{'id':F['requestId'],'mode':'initialize','source':None,'phase':'activated','publication':{'manifest':manifest,'checkpoint':checkpoint,'checkpointObjectId':F['checkpointObjectId']}}}
    request = {'expectedPeerId':peer['peerId'],'profile':profile,'control':control}
    state = {'peer':peer,'profile':None,'control':None,'root':None,'checkpoint':None,'manifest':None,'otherLibraryState':False,'requestIdUsedByOtherIdentity':False}
    return request, state

def test_metadata_and_admission_matrix():
    request, state = setup_case(); account = state['peer']['accountId']
    made = admit_initial_library(request, account, state); assert made['kind'] == 'create'
    assert made['profile']['origin'] == {'kind':'local-initialize'}
    assert len(canonical_json(request).encode('utf8')) == F['golden']['requestJsonUtf8ByteCount']
    assert edit_content_hash(request) == F['golden']['requestSha256']
    assert request['control']['transition']['publication']['manifest']['checkpointSha256'] == F['golden']['checkpointSha256']
    assert made['profile']['initialization']['requestSha256'] == F['golden']['requestSha256']
    altered_origin=deepcopy(made['profile']); altered_origin['origin']={'kind':'activated-installation','source':'import','controlId':F['requestId'],'manifestId':F['manifestId'],'installedScope':made['profile']['initialization']['initialScope']}; altered_origin['initialization']=None
    with pytest.raises(Exception): assert_initialization_unchanged(made['profile'],altered_origin)
    publication = request['control']['transition']['publication']
    state.update(profile=made['profile'], control=request['control'], root=publication['checkpoint']['roots'][0], checkpoint=publication['checkpoint'], manifest=publication['manifest'])
    assert admit_initial_library(request, account, state) == {'kind':'retry','receipt':made['receipt']}
    changed = deepcopy(state); changed['profile']['title']='renamed'; changed['profile']['remote']={'kind':'drive','folderId':'folder'}; changed['otherLibraryState']=True
    assert_initialization_unchanged(state['profile'], changed['profile'])
    assert admit_initial_library(request, account, changed)['receipt'] == made['receipt']
    rotated = deepcopy(changed); current = rotated['control']; initial = deepcopy(current['active']); target = deepcopy(initial)
    target['id']=F['rootVersion']; target['scope']['epoch']='later-epoch'
    current['id']=F['manifestId']; current['epochs'].append('later-epoch'); current['active']=target
    current['transition']={'id':F['manifestId'],'mode':'publish','source':initial,'phase':'activated','publication':{**deepcopy(publication),'manifest':target}}
    assert admit_initial_library(request, account, rotated)['receipt'] == made['receipt']
    altered = deepcopy(request); altered['profile']['title']='different'
    with pytest.raises(Exception): admit_initial_library(altered, account, state)
    for key in ('profile','control','root','checkpoint','manifest'):
        partial = deepcopy(state); partial[key] = None
        with pytest.raises(Exception): admit_initial_library(request, account, partial)
    partial = deepcopy(state); partial['root']['version']=F['manifestId']
    with pytest.raises(Exception): admit_initial_library(request, account, partial)
    for peer in (None, {**state['peer'], 'peerId':F['manifestId']}, {**state['peer'], 'accountId':'other'}):
        invalid = deepcopy(state); invalid['peer']=peer
        with pytest.raises(Exception): admit_initial_library(request, account, invalid)
    with pytest.raises(Exception): admit_initial_library(request, 'other', state)
    peer_only = setup_case()[1]; peer_only['otherLibraryState']=True
    with pytest.raises(Exception): admit_initial_library(request, account, peer_only)
    collision = deepcopy(state); collision['requestIdUsedByOtherIdentity']=True
    with pytest.raises(Exception): admit_initial_library(request, account, collision)
    for field, value in [('title',''),('revision','bad'),('remote',{'kind':'other','folderId':'x'})]:
        invalid = deepcopy(made['profile']); invalid[field]=value
        with pytest.raises(Exception): validate_canonicallibraryprofile(invalid)
    with pytest.raises(Exception): validate_canonicaldevicepeer({**state['peer'],'peerId':'bad'})
    with pytest.raises(Exception): assert_dataset_control_transition(request['control'], request['control'])
    for mutate in ('source','phase','epochs','resources','edits','roots'):
        bad = deepcopy(request); run=bad['control']['transition']; pub=run['publication']
        if mutate=='source': run['source']=deepcopy(pub['manifest'])
        elif mutate=='phase': run['phase']='prepared'
        elif mutate=='epochs': bad['control']['epochs'].append('other')
        elif mutate=='resources': pub['manifest']['resources']=[{'id':F['rootVersion'],'sha256':'a'*64,'mediaType':'x','byteLength':1}]
        elif mutate=='edits': pub['checkpoint']['edits']=[{}]
        else: pub['checkpoint']['roots'][0]['folders']=[{'id':F['rootVersion'],'title':'x','parentId':None,'position':0}]; pub['manifest']['checkpointSha256']=checkpoint_hash(pub['checkpoint']); bad['control']['active']=deepcopy(pub['manifest'])
        with pytest.raises(Exception): admit_initial_library(bad, account, setup_case()[1])

def test_old_control_sequences_remain_legal():
    previous=None
    for control in OLD['datasetControls']['initial']:
        assert_dataset_control_transition(previous,control); previous=control
    previous=OLD['datasetControls']['initial'][2]
    for control in OLD['datasetControls']['rotation']:
        assert_dataset_control_transition(previous,control); previous=control


def test_ordinary_repository_cannot_install_initialize_control(tmp_path):
    from contextlib import closing, contextmanager
    import sqlite3
    from native_core_test_authority import core_repository
    request, _ = setup_case(); publication = request['control']['transition']['publication']
    @contextmanager
    def connection():
        with closing(sqlite3.connect(tmp_path / 'library.sqlite3')) as db, db:
            yield db
    repository = core_repository(connection, publication['manifest']['scope'])
    repository.install_dataset(publication['manifest'], publication['checkpoint'])
    with pytest.raises(Exception, match='dataset-initialize-requires-bundle'):
        repository.replace_dataset_control(request['control'], None)
    assert repository.dataset_control() is None


def test_installed_origin_and_immutable_updates():
    profile=deepcopy(F['profile']); assert_canonical_profile(profile)
    renamed=deepcopy(profile); renamed['title']='new'; assert_initialization_unchanged(profile,renamed)
    changed=deepcopy(profile); changed['origin']['installedScope']['epoch']='later'
    with pytest.raises(Exception): assert_initialization_unchanged(profile,changed)
    invalid=deepcopy(profile); invalid['origin']['kind']='local-initialize'
    with pytest.raises(Exception): assert_canonical_profile(invalid)
    invalid=deepcopy(profile); invalid['origin']['installedScope']['accountId']='other'
    with pytest.raises(Exception): assert_canonical_profile(invalid)
    req,state=setup_case(); req['profile']['origin']=profile['origin']
    with pytest.raises(Exception): admit_initial_library(req,F['peer']['accountId'],state)
    req,state=setup_case(); req['profile']['initialization']=None
    with pytest.raises(Exception): admit_initial_library(req,F['peer']['accountId'],state)
