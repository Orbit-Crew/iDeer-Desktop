"""Validate the selected Issue 102 run, binding hashes and evidence privacy.

Use --functional STATE for an individual run, or --root REPOSITORY for the
final evidence bundle. Failed attempts may be retained under attempts/ but are
never substituted for the selected functional/result.json.
"""
import argparse
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument('--evidence', type=Path)
parser.add_argument('--functional', type=Path)
parser.add_argument('--allow-development', action='store_true')
parser.add_argument('--staged', action='store_true')
args = parser.parse_args()
root = args.root.resolve(strict=True)
evidence = (args.evidence or root / 'docs/acceptance/issue-102/evidence').resolve()
functional = args.functional.resolve(strict=True) if args.functional else evidence / 'functional'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_path(path):
    if not path.is_file() and path.with_name(path.name + '.gz').is_file():
        path = path.with_name(path.name + '.gz')
    raw = path.read_bytes()
    return gzip.decompress(raw) if path.suffix == '.gz' else raw


def data(path):
    return json.loads(read_path(path).decode('utf-8-sig'))


forbidden = {'private_key', 'session_token', 'business_token', 'access_token', 'refresh_token',
             'claim_token', 'authorization', 'cookie', 'csrf_token', 'device_key_ref', 'session_token_ref',
             'business_token_ref', 'claim_token_ref'}


def check_privacy(value):
    if isinstance(value, dict):
        rejected = forbidden.intersection(str(key).lower() for key in value)
        assert not rejected, ('credential fields in committed evidence', rejected)
        for item in value.values():
            check_privacy(item)
    elif isinstance(value, list):
        for item in value:
            check_privacy(item)
    elif isinstance(value, str):
        assert '-----BEGIN PRIVATE KEY-----' not in value
        assert not re.search(r'(?i)(?:Bearer|access_token=|session_token=)\s*eyJ[A-Za-z0-9_-]{16}', value)


result = data(functional / 'result.json')
assert result['status'] == 'passed', 'selected functional run did not pass'
assert result['installed'] or args.allow_development, 'final acceptance requires the installed candidate'
assert datetime.fromisoformat(result['finishedAt'].replace('Z', '+00:00')) >= datetime.fromisoformat(result['startedAt'].replace('Z', '+00:00'))
constants = {'BEFORE': 'BEFORE', 'AFTER': 'AFTER', 'NEWLINES': 'AFTER\r\n第二行\n'}
for name, text in constants.items():
    assert result['constants'][name] == {'text': text, 'bytes': len(text.encode()), 'sha256': digest(text.encode())}
required = {
    'T102-01': {'create', 'overwrite', 'unicode-newlines'},
    'T102-02': {'reject', 'timeout', 'changed-request-hash', 'web-approval', 'local-deny', 'outside-path', 'protected-path', 'link-escape'},
    'T102-03': {'admission-failure', 'admission-recovery-read', 'completion-failure', 'second-write-blocked', 'uncertain-restart', 'uncertain-recovery-read'},
    'T102-04': {'before-submit-cancel', 'before-write-cancel', 'before-write-disconnect', 'after-write-cancel', 'after-write-disconnect'},
}
operations = {operation['id']: operation for operation in result['operations']}
assert len(operations) == 21
for operation in operations.values():
    assert operation['phase'] == 'completed', operation['name']
    assert operation['threadId'] and operation['runId'] and operation['turnId']
    assert len(operation.get('recoveryAttempts', [])) <= 3
    for recovery in operation.get('recoveryAttempts', []):
        assert recovery['threadId'] == operation['threadId'] and recovery['runId'] == operation['runId']
        assert recovery['origin'] == 'actual Desktop reconnect UI click'
    check_privacy(operation)
auxiliary = result['auxiliaryOperations']
wire_events = [json.loads(line) for line in read_path(functional / 'wire-events.jsonl').decode().splitlines()]
assert len(auxiliary) == 4
expected_recoveries = {'before-write-cancel', 'before-write-disconnect', 'after-write-cancel', 'after-write-disconnect'}
assert {operations[row['recoveryFor']]['name'] for row in auxiliary} == expected_recoveries
assert len({row['id'] for row in auxiliary}) == 4 and not set(operations).intersection(row['id'] for row in auxiliary)
assert len({row['runId'] for row in list(operations.values()) + auxiliary}) == 25
for row in auxiliary:
    assert row['phase'] == 'completed' and row['capability'] == 'local.files.read'
    assert row['threadId'] and row['turnId'] and row['runId']
    assert row['name'] == 'health-after-' + operations[row['recoveryFor']]['name']
    assert row['requested'] == result['constants']['BEFORE']
    assert len(row['dispatches']) == len(row['tasks']) == 1 and row['tasks'][0]['status'] == 200
    task = row['tasks'][0]['body']
    receipt = task['receipt']
    assert task['run_id'] == receipt['run_id'] == row['runId'] and task['tool_call_id']
    assert task['task_id'] == receipt['task_id'] == row['dispatches'][0]['taskId']
    assert receipt['request_hash'] == row['dispatches'][0]['requestHash']
    assert receipt['capability'] == 'local.files.read' and receipt['status'] == 'completed'
    assert task['result']['content'] == 'BEFORE' and task['result']['bytes'] == 6
    assert task['result']['sha256'] == digest(b'BEFORE')
    assert row['proof'] == {'after': {'exists': True, 'text': 'BEFORE', 'bytes': 6, 'sha256': digest(b'BEFORE')},
                            'dispatchCount': 1, 'executionCount': 1, 'storageError': '', 'deliveryState': 'confirmed'}
    assert row['finalDispatchCount'] == 1
    assert len([event for event in wire_events if event['event'] == 'task-dispatched' and event['runId'] == row['runId']]) == 1
    assert row['uncertainRowsBefore'] == row['uncertainRowsAfter']
    original_uncertain = next(operation for operation in operations.values() if operation['name'] == 'completion-failure')
    retained = next(item for item in row['uncertainRowsAfter'] if item['task_id'] == original_uncertain['approval']['taskId'])
    assert retained['delivery_state'] == 'uncertain' and retained['error_code'] == 'RESULT_UNCERTAIN'
    check_privacy(row)
cases = {}
for scenario_id, names in required.items():
    scenario = result['scenarios'][scenario_id]
    assert scenario['status'] == 'passed', scenario_id
    assert len(scenario['cases']) == len(names)
    assert {row['name'] for row in scenario['cases']} == names
    for case in scenario['cases']:
        assert case['status'] == 'passed'
        operation = operations[case['operationId']]
        assert operation['scenario'] == scenario_id
        cases[case['name']] = case
        after = case.get('after')
        if after:
            expected = constants['NEWLINES'] if case['name'] == 'unicode-newlines' else (
                constants['AFTER'] if case['name'] in {'create', 'overwrite', 'completion-failure', 'uncertain-restart', 'after-write-cancel', 'after-write-disconnect'} else constants['BEFORE'])
            assert after == {'exists': True, 'bytes': len(expected.encode()), 'sha256': digest(expected.encode()), 'text': expected}, case['name']
for name in ('create', 'overwrite', 'unicode-newlines'):
    case = cases[name]
    operation = operations[case['operationId']]
    approval = operation['approval']
    assert operation['decision']['approved'] is True
    assert operation['decision']['origin'] == 'actual Desktop chat UI click'
    assert approval['runId'] == operation['runId'] and approval['threadId'] == operation['threadId']
    assert approval['exactContentSHA256'] == operation['requested']['sha256'] == case['after']['sha256']
    assert len(operation['dispatches']) == 1
    assert operation['dispatches'][0]['requestHash'] == approval['requestHash']
    task = operation['tasks'][0]['body']
    assert task['task_id'] == approval['taskId'] == task['receipt']['task_id'] == case['taskId']
    assert task['run_id'] == operation['runId'] == task['receipt']['run_id']
    assert task['tool_call_id'] == case['toolCallId']
    assert task['receipt']['request_hash'] == approval['requestHash']
    assert task['receipt']['status'] == 'completed' and task['receipt']['consent_decision'] == 'approved'
    assert task['result']['sha256'] == case['after']['sha256'] and task['result']['bytes'] == case['after']['bytes']
    assert operation['archivedReceipt']['tool_call_id'] == task['tool_call_id']
    assert operation['archivedReceipt']['local_execution_receipt']['task_id'] == task['task_id']
    assert operation['archivedReceipt']['local_execution_receipt']['request_hash'] == approval['requestHash']
    assert case['executionCount'] == 1
assert cases['create']['before']['exists'] is False
assert cases['overwrite']['before']['sha256'] == digest(b'BEFORE')
assert cases['changed-request-hash']['error'] == 'CONSENT_MISMATCH'
assert cases['changed-request-hash']['staleApprovalError'] in {'CONSENT_MISMATCH', 'CONSENT_UNAVAILABLE'}
assert cases['web-approval']['response']['status'] == 403
assert cases['web-approval']['response']['body']['detail']['code'] == 'LOCAL_APPROVAL_REQUIRED'
assert cases['timeout']['timeout']['configuredSeconds'] == 300
assert cases['timeout']['timeout']['signedTaskDeadlineSeconds'] == 305
for name in ('outside-path', 'protected-path', 'link-escape'):
    assert cases[name]['executionCount'] == 0 and cases[name]['noApprovalCard'] is True
    assert cases[name]['noApprovalSamples'] >= 1
assert cases['admission-failure']['addedRows'] == 0
assert cases['completion-failure']['uncertain']['delivery_state'] == 'uncertain'
assert cases['completion-failure']['uncertain']['error_code'] == 'RESULT_UNCERTAIN'
assert cases['second-write-blocked']['addedRows'] == 0 and cases['second-write-blocked']['executionCount'] == 0
for name in ('admission-recovery-read', 'uncertain-recovery-read'):
    assert cases[name]['receiptStatus'] == 'completed'
    assert cases[name]['readSHA256'] == digest(b'BEFORE')
assert cases['uncertain-restart']['dispatchCount'] == 1
assert cases['before-submit-cancel']['dispatchCount'] == 0
for name in ('before-submit-cancel', 'before-write-cancel'):
    assert operations[cases[name]['operationId']]['runStatus'] == 'interrupted'
for name in ('before-write-cancel', 'before-write-disconnect', 'after-write-cancel', 'after-write-disconnect'):
    assert cases[name]['dispatchCount'] == 1
for name in ('after-write-cancel', 'after-write-disconnect'):
    assert cases[name]['executionCount'] == 1
    operation = operations[cases[name]['operationId']]
    archive = cases[name]['recoveredArchive']
    assert archive == operation['recoveredArchive']
    assert archive['httpStatus'] == 200 and archive['receipt']['status'] == 'completed'
    assert archive['task_id'] == archive['task']['task_id'] == archive['receipt']['task_id'] == operation['approval']['taskId']
    assert archive['task']['run_id'] == archive['receipt']['run_id'] == operation['runId']
    assert archive['task']['request_hash'] == archive['receipt']['request_hash'] == operation['approval']['requestHash']
    assert archive['receipt']['capability'] == 'local.files.write'
    assert archive['receipt']['consent_decision'] == 'approved' and archive['receipt']['policy_decision'] == 'allow'
    assert archive['evidence']['tool_call_id'] == archive['task']['tool_call_id'] == operation['dispatches'][0]['toolCallId']
    local = next(row for row in result['finalLocalHistory']['rows'] if row['task_id'] == archive['task_id'])
    assert local['delivery_state'] == 'confirmed' and local['status'] == 'completed'
    assert archive['receipt_id'] == local['receipt_id'] and archive['receipt_hash'] == local['receipt_hash']
    assert archive['acknowledgment'] and archive['acknowledgment'] == local['acknowledgment']
    original = next(row for row in wire_events if row['event'] == 'task-result-received' and row['taskId'] == archive['task_id'] and row['receipt']['status'] == 'completed')
    assert archive['receipt']['result_hash'] == original['receipt']['result_hash']
    assert original['result']['sha256'] == digest(b'AFTER') and original['result']['bytes'] == 5
    assert cases[name]['liveTask'] == operation['liveTask']['response']['body']
    assert operation['liveTask']['response']['status'] == 200
assert cases['after-write-cancel']['runStatus'] == 'interrupted'
assert result['finalLocalAudit']['integrity'] is True
assert result['fixtureCleanup'] == {'removed': True, 'appClosed': True}
assert not set(result).intersection({'error', 'cleanupError', 'shutdownError', 'finalMetadataError', 'finalFixtureObservationError'})
final_files = result['finalFixtureFiles']
after_files = {'W/new.txt', 'W/target.txt', 'W/completion.txt', 'W/after-cancel.txt', 'W/after-disconnect.txt'}
assert len(final_files) == 19
for name, actual in final_files.items():
    expected = constants['NEWLINES'] if name == 'W/unicode.txt' else constants['AFTER'] if name in after_files else constants['BEFORE']
    assert actual == {'exists': True, 'bytes': len(expected.encode()), 'sha256': digest(expected.encode()), 'text': expected}, name
assert data(functional / 'credential-cleanup.json') == {'removed': 6, 'failures': []}
assert data(functional / 'gateway-cleanup.json')['exited'] is True
if result['installed']:
    restoration = data(functional / 'profile-restoration.json')
    assert restoration['restored'] and restoration['appClosed'] and restoration['acceptanceExitCode'] == 0
    assert restoration['before'] == restoration['after']
    assert len(restoration['before']) == restoration['unchangedFiles']
check_privacy(result)
for line in read_path(functional / 'wire-events.jsonl').decode().splitlines():
    check_privacy(json.loads(line))

if not args.functional:
    manifest = data(evidence / 'manifest.json')
    names = [row['path'] for row in manifest]
    assert len(names) == len(set(names)), 'duplicate manifest entry'
    actual = {path.relative_to(evidence).as_posix() for path in evidence.rglob('*') if path.is_file() and path.name != 'manifest.json'}
    assert set(names) == actual, 'evidence manifest is incomplete'
    for row in manifest:
        path = (evidence / row['path']).resolve(strict=True)
        assert path.is_relative_to(evidence)
        assert path.stat().st_size == row['bytes'] and digest(path.read_bytes()) == row['sha256'], row['path']
        if args.staged:
            blob = subprocess.check_output(['git', '-C', str(root), 'show', ':' + path.relative_to(root).as_posix()])
            assert digest(blob) == row['sha256'], row['path']
        if path.name.endswith(('.json', '.json.gz')):
            check_privacy(data(path))
        elif path.name.endswith('.jsonl'):
            for line in path.read_text(encoding='utf-8-sig').splitlines():
                check_privacy(json.loads(line))
    desktop = data(evidence / 'desktop/desktop-source-binding.json')
    server = data(evidence / 'server/server-source-binding.json')
    for binding in (desktop, server):
        canonical = json.dumps(binding['files'], sort_keys=True, separators=(',', ':')).encode()
        assert digest(canonical) == binding['sourceSHA256']
        assert binding['branch'] == 'feat/issue-102'
    for row in desktop['files']:
        assert digest((root / row['path']).read_bytes()) == row['sha256'], row['path']
    assert result['candidate']['acceptanceFiles']
    for row in result['candidate']['acceptanceFiles']:
        assert digest((root / row['path']).read_bytes()) == row['sha256'], 'acceptance runner changed since the selected run'
    assert result['candidate']['serverHead'] == server['headAtBinding']
    assert result['candidate']['serverSourceSHA256'] == server['sourceSHA256']
    desktop_files = {row['path']: row['sha256'] for row in desktop['files']}
    assert result['candidate']['runtimeCore']
    for row in result['candidate']['runtimeCore']:
        assert desktop_files[row['path']] == row['sha256'], 'installed Runtime differs from bound candidate'
    packages = data(evidence / 'desktop/package-hashes.json')
    hashes = set(packages.values())
    assert result['candidate']['runtimePythonSHA256'] in hashes
    assert result['candidate']['appASARSHA256'] in hashes
    assert result['candidate']['executableSHA256'] in hashes
    assert any('setup.exe' in name and re.fullmatch('[0-9a-f]{64}', value) for name, value in packages.items())
    for name, value in packages.items():
        assert digest((root / name.replace('\\', '/')).read_bytes()) == value
    locks = data(evidence / 'desktop/lock-hashes.json')
    assert {'package.json', 'package-lock.json', 'local-runtime/distribution.lock.json', 'electron-builder.yml'} <= set(locks)
    for name, value in locks.items():
        assert digest((root / name).read_bytes()) == value
    for name in ('typecheck-release', 'desktop-tests-release', 'security-release', 'runtime-static-verified',
                 'runtime-tests-verified', 'dist-win-release', 'install-lifecycle-release', 'functional-final-command'):
        assert data(evidence / ('desktop/' + name + '.json'))['exitCode'] == 0, name
    for document in (root / 'docs/acceptance/issue-102/report.md', root / 'docs/acceptance/issue-102/code-review.md'):
        for target in re.findall(r'\[[^\]]+\]\(([^)]+)\)', document.read_text(encoding='utf-8-sig')):
            if not target.startswith(('http:', 'https:', '#')):
                assert (document.parent / target.split('#')[0]).exists(), target

print(json.dumps({'status': 'passed', 'scenarios': len(required), 'subcases': len(cases), 'operations': len(operations),
                  'auxiliaryOperations': len(auxiliary), 'totalRequests': len(operations) + len(auxiliary),
                  'installed': result['installed'], 'hashesValid': True, 'credentialFields': 0,
                  'scope': 'functional' if args.functional else 'final evidence bundle'}))
