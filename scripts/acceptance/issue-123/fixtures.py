"""Create exact connector fixture packages; never read user material.

Follows local-runtime/tests/test_connector_install.py::build_package (PR #35):
legal packages are directories holding connector.json plus the frozen fixture
entry; invalid variants are derived from the same frozen constants. Invalid
slug or version values live only inside the manifest JSON - they never name a
fixture directory (the PR #35 lesson). Every hash the driver asserts is
computed here from the exact bytes, mirroring core/connector_install.py:
the manifest hash over the normalized manifest projection and the canonical
package hash over sorted relative POSIX paths with per-file digests.
"""
import hashlib
import json
from pathlib import Path
import sys

state = Path(sys.argv[1]).resolve(strict=True)
target = state / 'fixtures'
target.mkdir(exist_ok=False)
repo = Path(__file__).resolve().parents[3]
entry_source = repo / 'local-runtime' / 'tests' / 'fixtures' / 'connector_mcp_server.py'
entry_bytes = entry_source.read_bytes()

MANIFEST_NAME = 'connector.json'


def manifest_hash(normalized):
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode()).hexdigest()


def package_hash(root):
    entries = {}
    for member in sorted(root.rglob('*')):
        if member.is_file():
            entries[member.relative_to(root).as_posix()] = hashlib.sha256(member.read_bytes()).hexdigest()
    encoded = json.dumps(sorted(entries.items()), ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(encoded.encode()).hexdigest(), entries


def build(name, *, slug='t123-echo', display_name='T123 Echo Connector', version='1.2.0',
          entry='server.py', requirements=None, manifest_raw=None, extra=None, entry_bytes_override=None):
    package = target / name
    package.mkdir(exist_ok=False)
    manifest = {'connector': slug, 'displayName': display_name, 'version': version,
        'entry': entry, 'requirements': {'python': '>=3.9'} if requirements is None else requirements}
    if manifest_raw is not None:
        (package / MANIFEST_NAME).write_text(manifest_raw, encoding='utf-8')
    else:
        (package / MANIFEST_NAME).write_text(json.dumps(manifest), encoding='utf-8')
    payload = entry_bytes if entry_bytes_override is None else entry_bytes_override
    if entry == 'server.py':
        (package / 'server.py').write_bytes(payload)
    for member, data in (extra or {}).items():
        destination = package / member
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return package


def projection(name, slug, display_name, version, entry='server.py', requirements=None):
    normalized = {'slug': slug, 'display_name': display_name, 'version': version,
        'entry': entry, 'requirements': {'python': '>=3.9'} if requirements is None else requirements}
    package_hash_value, entries = package_hash(target / name)
    return {'path': str(target / name), 'slug': slug, 'displayName': display_name, 'version': version,
        'entry': entry, 'manifestHash': manifest_hash(normalized), 'packageHash': package_hash_value,
        'fileCount': len(entries), 'entrySHA256': entries.get(entry, ''),
        'files': sorted(entries)}


build('good')
build('upgrade', version='1.2.1')
build('conflict', display_name='T123 Echo Connector Modified')
records = {
    'good': projection('good', 't123-echo', 'T123 Echo Connector', '1.2.0'),
    'upgrade': projection('upgrade', 't123-echo', 'T123 Echo Connector', '1.2.1'),
    'conflict': projection('conflict', 't123-echo', 'T123 Echo Connector Modified', '1.2.0'),
    'case-manifest': None,
    'case-native': None,
    'case-oversize': None,
    'case-dependency': None,
    'case-floor': None,
    'case-entry': None,
    'case-escape': None,
}
records['conflict']['note'] = 'same slug and version as good with a different manifest (displayName) -> frozen-binding conflict'
records['upgrade']['note'] = 'genuine upgrade: new version declares its own manifest hash'

build('case-manifest', manifest_raw='{not json')
records['case-manifest'] = {'path': str(target / 'case-manifest'), 'expected': 'CONNECTOR_MANIFEST_INVALID'}
build('case-native', extra={'helper.dll': b'T123_NATIVE_MEMBER_BYTES'})
records['case-native'] = {'path': str(target / 'case-native'), 'expected': 'CONNECTOR_PACKAGE_INVALID'}
build('case-oversize', extra={'assets/blob.bin': bytes(8 * 1024 * 1024 + 1)})
records['case-oversize'] = {'path': str(target / 'case-oversize'), 'expected': 'CONNECTOR_PACKAGE_INVALID'}
build('case-dependency', requirements={'dotnet': '>=8.0'})
records['case-dependency'] = {'path': str(target / 'case-dependency'), 'expected': 'CONNECTOR_DEPENDENCY_MISSING'}
build('case-floor', requirements={'python': '>=99.0'})
records['case-floor'] = {'path': str(target / 'case-floor'), 'expected': 'CONNECTOR_VERSION_MISMATCH'}
build('case-entry', entry='absent.py')
# The entry named by the manifest was never written: a missing entry file.
records['case-entry'] = {'path': str(target / 'case-entry'), 'expected': 'CONNECTOR_ENTRY_INVALID'}
build('case-escape', entry='../escape.py')
records['case-escape'] = {'path': str(target / 'case-escape'), 'expected': 'CONNECTOR_MANIFEST_INVALID',
    'note': 'escaping entry is refused by the manifest grammar; nothing is ever written outside the package'}

records['markers'] = {'echo': 'T123-echo-marker', 'managedWrite': 'T123_MANAGED_WRITE_OK',
    'outsideWrite': 'T123_OUTSIDE_WRITE_ATTEMPT'}
records['entrySHA256'] = hashlib.sha256(entry_bytes).hexdigest()
(state / 'fixtures.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
print(json.dumps({'created': len(records), 'entrySource': str(entry_source), 'synthetic': True}))
