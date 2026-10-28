"""Create exact synthetic Skill-script fixtures; never read user material.

Mirrors the issue-120 exact-byte package construction (canonical package hash
over sorted relative POSIX paths, length-prefixed) and extends every package
with an ``execution-environment`` front-matter block. Every derived fact the
driver asserts - script digest, requirements fingerprint (the frozen
cross-repo canonical-JSON algorithm shared with
``app/agentplatform/resources/skill_environment.py``), package hash - is
computed here from the fixture bytes, never from implementation output.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

state = Path(sys.argv[1]).resolve(strict=True)
target = state / 'fixtures'
target.mkdir(exist_ok=False)

DECLARATION_FIELDS = ('os', 'dependencies', 'software', 'tools', 'data')


def fingerprint(declaration):
    payload = {'target': None}
    payload.update({field: [] for field in DECLARATION_FIELDS})
    payload.update({key: declaration[key] for key in payload if key in declaration})
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode()).hexdigest()


def package_hash(members):
    digest = hashlib.sha256()
    for name, data in sorted(members.items()):
        encoded = name.encode()
        digest.update(len(encoded).to_bytes(4, 'big'))
        digest.update(encoded)
        digest.update(data)
    return digest.hexdigest()


def skill_md(declaration):
    lines = ['---', 'name: {slug}', 'description: Synthetic frozen script skill acceptance',
        'execution-environment:', f'  target: {declaration["target"]}']
    for field in DECLARATION_FIELDS:
        lines.append(f'  {field}: [' + ', '.join(declaration[field]) + ']')
    lines += ['---', '', 'Weekly synthetic report skill. The frozen scripts are the only surface.']
    return '\n'.join(lines) + '\n'


def build(slug, declaration, script_name, script):
    body = skill_md(declaration).replace('{slug}', slug)
    members = {'SKILL.md': body.encode(), f'scripts/{script_name}': script.encode()}
    picked = target / f'{slug}.zip'
    with zipfile.ZipFile(picked, 'w') as bundle:
        for name, data in members.items():
            bundle.writestr(name, data)
    script_path = f'scripts/{script_name}'
    return {'path': str(picked), 'slug': slug, 'skillMd': body,
        'packageHash': package_hash(members), 'scriptPath': script_path,
        'script': script, 'scriptSHA256': hashlib.sha256(script.encode()).hexdigest(),
        'declaration': declaration, 'requirementsHash': fingerprint(declaration),
        'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                  for name, data in sorted(members.items())]}


SERVER_V1 = {'target': 'server', 'os': ['linux'], 'dependencies': ['python3', 'pandas'],
    'software': [], 'tools': [], 'data': []}
SERVER_V2 = {'target': 'server', 'os': ['linux'], 'dependencies': ['python3', 'pandas', 'numpy'],
    'software': [], 'tools': [], 'data': []}
DEVICE_OK = {'target': 'user_device', 'os': ['windows'], 'dependencies': ['python3'],
    'software': [], 'tools': [], 'data': []}
DEVICE_LINUX = {'target': 'user_device', 'os': ['linux'], 'dependencies': ['python3'],
    'software': [], 'tools': [], 'data': []}

records = {
    'server': build('t122-server-decl', SERVER_V1, 'weekly_report.py', "print('server-fixed-ok')\n"),
    'device': build('t122-device-decl', DEVICE_OK, 'device_report.py', "print('device-fixed-ok')\n"),
    'deviceLinux': build('t122-device-linux', DEVICE_LINUX, 'device_report.py', "print('never-runs')\n"),
}

base = records['server']['skillMd']
records['serverV2SkillMd'] = base.replace(
    'dependencies: [python3, pandas]', 'dependencies: [python3, pandas, numpy]')
records['serverV3SkillMd'] = records['serverV2SkillMd'] + (
    'Prose-only follow-up note: the frozen scripts and declared scope are unchanged.\n')
assert records['serverV2SkillMd'] != base and 'numpy' in records['serverV2SkillMd']
records['fingerprintV2'] = fingerprint(SERVER_V2)
records['fixedMarkers'] = {'server': 'server-fixed-ok', 'device': 'device-fixed-ok',
    'drift': 'T122_DRIFTED_BYTES'}
(state / 'fixtures.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
print(json.dumps({'created': len(records), 'synthetic': True}))
