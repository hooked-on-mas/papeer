"""Actual disk SQLite component recovery through production Native authority/routes.

Separate owned subprocesses model a lost durable reply and fresh-process recovery.
This is not a Native UI/transport test and does not close the P4.2b parent.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys


def test_native_authority_library_resolution_disk_cold_retry_preserves_full_snapshot_and_denials(tmp_path):
    root = Path(__file__).resolve().parents[2]
    source = Path(__file__).with_name('_library_resolution_cold_worker.py')
    owned = tmp_path / 'native-library-resolution-cold'
    proof = owned / 'proof'
    proof.mkdir(parents=True)
    for name in ('legacy', 'device', 'roaming', 'xdg-data', 'xdg-state', 'xdg-cache', 'xdg-config', 'temp'):
        (owned / name).mkdir()
    executed = proof / 'executed-library-resolution-worker.py'
    with executed.open('xb') as stream: stream.write(source.read_bytes())
    worker_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    env = os.environ.copy()
    for key in list(env):
        if key.upper().startswith(('PAPEER_', 'PAPERDESK_', 'WEBVIEW2_', 'TAURI_')) or key.upper() in ('PYTHONPATH', 'PYTHONHOME'):
            env.pop(key, None)
    env.update(PAPEER_DATA_DIR=str(owned / 'legacy'), PAPEER_TOKEN=secrets.token_urlsafe(32),
        LOCALAPPDATA=str(owned / 'device'), APPDATA=str(owned / 'roaming'), XDG_DATA_HOME=str(owned / 'xdg-data'),
        XDG_STATE_HOME=str(owned / 'xdg-state'), XDG_CACHE_HOME=str(owned / 'xdg-cache'), XDG_CONFIG_HOME=str(owned / 'xdg-config'),
        TEMP=str(owned / 'temp'), TMP=str(owned / 'temp'), TMPDIR=str(owned / 'temp'),
        PYTHONPATH=str(root), PYTHONDONTWRITEBYTECODE='1')
    phases, captures = [], []
    previous = None
    for phase in ('prepare', 'recover', 'confirm'):
        assert hashlib.sha256(source.read_bytes()).hexdigest() == worker_sha
        assert executed.read_bytes() == source.read_bytes()
        output = proof / (phase + '.json')
        argv = [sys.executable, '-B', str(executed), phase, '--root', str(owned), '--output', str(output)]
        if previous: argv.extend(['--previous', str(previous)])
        stdout, stderr = proof / (phase + '.stdout.log'), proof / (phase + '.stderr.log')
        with stdout.open('xb') as out, stderr.open('xb') as err:
            child = subprocess.Popen(argv, cwd=root, env=env, stdout=out, stderr=err,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            capture = {'phase': phase, 'argv': argv, 'cwd': str(root), 'ownedLauncherPid': child.pid, 'workerSourceSha256': worker_sha}
            with (proof / (phase + '.execution.json')).open('xb') as stream:
                stream.write((json.dumps(capture, indent=2) + '\n').encode('utf8'))
            code = child.wait(timeout=180)  # A timeout fails without killing a process or erasing its proof.
        capture['exitCode'] = code
        capture['stdoutSha256'] = hashlib.sha256(stdout.read_bytes()).hexdigest()
        capture['stderrSha256'] = hashlib.sha256(stderr.read_bytes()).hexdigest()
        with (proof / (phase + '.capture.json')).open('xb') as stream:
            stream.write((json.dumps(capture, indent=2) + '\n').encode('utf8'))
        assert code == 0, f'{phase} failed; raw logs retained at {proof}'
        assert stderr.read_bytes() == b''
        state = json.loads(output.read_bytes())
        assert state['phase'] == phase and isinstance(state['ownPid'], int) and state['ownPid'] > 0
        assert len(state['denied']) == 12 and set(state['denied'].values()) == {403}
        diagnostic = json.loads(stdout.read_bytes())
        assert diagnostic['phase'] == phase and diagnostic['ownPid'] == state['ownPid']
        assert diagnostic['resolutionId'] == state['expected']['resolution']['id']
        assert diagnostic['proofSha256'] == hashlib.sha256(output.read_bytes()).hexdigest()
        capture['workerSelfPid'] = state['ownPid']  # Keep authentic launcher and interpreter PIDs separate.
        phases.append(state)
        captures.append(capture)
        previous = output
    first, recovered, confirmed = phases
    assert len({state['generation'] for state in phases}) == 3
    assert all(state['scope'] == first['scope'] and state['sqlitePath'] == first['sqlitePath'] for state in phases)
    assert all(state['expected'] == first['expected'] and state['selected'] == first['selected'] for state in phases)
    assert recovered['rawBefore'] == first['rawAfter']
    assert confirmed['rawBefore'] == recovered['rawAfter'] == confirmed['rawAfter']
    assert all(row['exitCode'] == 0 for row in captures)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == worker_sha and executed.read_bytes() == source.read_bytes()
    with (proof / 'passed-captures.json').open('xb') as stream:
        stream.write((json.dumps(captures, indent=2) + '\n').encode('utf8'))
    print(json.dumps({'contract': 'production Native authority disk SQLite resolution component',
        'phases': [state['phase'] for state in phases], 'resolutionId': first['expected']['resolution']['id'],
        'proofDirectory': str(proof), 'captures': captures,
        'qualification': 'modeled lost reply, normal separate worker exits; no frontend registry, Native UI, transport or P4.2b parent completion'}))
