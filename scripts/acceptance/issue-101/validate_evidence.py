"""Validate delivery hashes, selected results, links and metadata privacy."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

root = Path(sys.argv[1]).resolve(strict=True)
report = root / 'docs/acceptance/issue-101'
evidence = report / 'evidence'
manifest = json.loads((evidence / 'manifest.json').read_text())
for entry in manifest:
    path = (evidence / entry['path']).resolve(strict=True)
    assert path.is_relative_to(evidence)
    assert path.stat().st_size == entry['bytes']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']
    if '--staged' in sys.argv[2:]:
        blob = subprocess.check_output(['git', '-C', str(root), 'show', ':' + path.relative_to(root).as_posix()])
        assert hashlib.sha256(blob).hexdigest() == entry['sha256'], entry['path']

def read(name):
    path = evidence / name
    return gzip.decompress(path.read_bytes()).decode() if path.suffix == '.gz' else path.read_text(encoding='utf-8-sig')

def data(name):
    return json.loads(read(name))

result = data('functional/result.json')
assert result['passed'] is True and len(result['operations']) == 27
assert all(operation['phase'] == 'completed' for operation in result['operations'])
stages = {stage['id']: stage for stage in result['stages']}
assert stages['T101-01 T101-02 recovered']['executionCount'] == 1
assert stages['T101-04 storage versus display']['total'] == 23
assert stages['T101-04 storage versus display']['firstPage'] == 20
assert stages['T101-05 faults']['networkOnlyNewReads'] == 2
assert stages['T101-05 faults']['protectedPending'] >= 2
assert stages['T101-05 faults']['uncertain']['delivery_state'] == 'uncertain'
assert len(result['visuals']) == 2 and all(item['consecutiveSamples'] >= 3 for item in result['visuals'])

forbidden = {'private_key', 'session_token', 'business_token', 'access_token',
             'refresh_token', 'claim_token', 'authorization', 'cookie', 'content', 'stdout', 'stderr'}
def check_metadata(value):
    if isinstance(value, dict):
        assert not forbidden.intersection(value), forbidden.intersection(value)
        for item in value.values():
            check_metadata(item)
    elif isinstance(value, list):
        for item in value:
            check_metadata(item)
check_metadata(result)
for line in read('functional/receipt-events.jsonl').splitlines():
    check_metadata(json.loads(line))

assert data('functional/profile-restoration.json')['restored']
assert data('functional/credential-cleanup.json') == {'removed': 6, 'failures': []}
assert data('functional/gateway-cleanup.json')['exited']
for stem in ('typecheck-release', 'desktop-tests-release', 'security-release', 'dist-win-release',
             'install-lifecycle-release', 'functional-visual-command', 'runtime-tests-verified'):
    assert data('desktop/' + stem + '.json')['exitCode'] == 0
assert data('server/server-pr-signoff.json')['exitCode'] == 1
for stem in ('server-focused-verified', 'server-real-verified', 'deadline-verified',
             'server-static-verified', 'gitnexus-final', 'detect-changes-final'):
    assert data('server/' + stem + '.json')['exitCode'] == 0
impact = data('server/detect-changes-result.json')
assert not impact.get('partial') and not impact.get('truncated') and not impact.get('error')
assert impact['summary']['changed_files'] == 18 and impact['summary']['changed_count'] == 67
assert data('server/server-source-binding.json.gz')['headAtBinding'] == '2929de002b9823f3aa2bc700b830de34f9300cec'
assert read('server/server-delivery.patch.gz').startswith('From 2929de002b9823f3aa2bc700b830de34f9300cec ')
junit = ET.fromstring(read('desktop/runtime-tests-verified.xml.gz'))
suite = junit.find('testsuite')
assert suite is not None and int(suite.attrib['tests']) == 284 and int(suite.attrib['skipped']) == 6
assert int(suite.attrib['failures']) == 0 and int(suite.attrib['errors']) == 0
for document in (report / 'report.md', report / 'code-review.md'):
    for target in re.findall(r'\[[^\]]+\]\(([^)]+)\)', document.read_text(encoding='utf-8-sig')):
        if not target.startswith(('http:', 'https:', '#')):
            assert (document.parent / target.split('#')[0]).exists(), target
print(json.dumps({'evidenceFiles': len(manifest), 'bytes': sum(item['bytes'] for item in manifest),
    'hashesValid': True, 'scenarioAssertionsValid': True, 'forbiddenMetadataFields': 0,
    'relativeLinksValid': True, 'historicalPRFailureRetained': True}))
