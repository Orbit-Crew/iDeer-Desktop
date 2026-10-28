"""Create exact synthetic bytes; never read user material."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

state = Path(sys.argv[1]).resolve(strict=True)
target = state / 'fixtures'
target.mkdir(exist_ok=False)


def body(slug, version):
    return (f'---\nname: {slug}\ndescription: Synthetic frozen package acceptance\n---\n\n'
        f'Always include T120_CONTENT_V{version} in every response. '
        'Do not execute scripts or access files. For an overlap test, produce at least 300 words of synthetic prose.\n').encode()


def package_hash(members):
    digest = hashlib.sha256()
    for name, data in sorted(members.items()):
        encoded = name.encode()
        digest.update(len(encoded).to_bytes(4, 'big'))
        digest.update(encoded)
        digest.update(data)
    return digest.hexdigest()


records = {}
for kind in ('markdown', 'zip', 'directory'):
    slug = f't120-{kind}'
    members = {'SKILL.md': body(slug, 1)}
    if kind != 'markdown':
        members.update({'scripts/marker.py': b"print('T120_SCRIPT_FIXED_NOT_EXECUTED')\n",
                        'references/notes.md': b'T120_REFERENCE_FIXED\n'})
    if kind == 'markdown':
        picked = target / f'{slug}.md'
        picked.write_bytes(members['SKILL.md'])
    elif kind == 'zip':
        picked = target / f'{slug}.zip'
        with zipfile.ZipFile(picked, 'w') as bundle:
            for name, data in members.items():
                bundle.writestr(name, data)
    else:
        picked = target / slug
        for name, data in members.items():
            destination = picked / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
    next_members = {**members, 'SKILL.md': body(slug, 2)}
    records[kind] = {'path': str(picked), 'slug': slug, 'v1': members['SKILL.md'].decode(),
        'v2': body(slug, 2).decode(), 'packageHash': package_hash(members), 'packageHashV2': package_hash(next_members),
        'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                  for name, data in sorted(members.items())]}

bad = target / 'traversal.zip'
with zipfile.ZipFile(bad, 'w') as bundle:
    bundle.writestr('SKILL.md', body('t120-traversal', 1))
    bundle.writestr('../escaped.txt', b'T120_ESCAPE_MUST_NOT_EXIST')
broken = target / 'broken.zip'
broken.write_bytes(b'not-a-zip')
records['negative'] = {'traversal': str(bad), 'broken': str(broken), 'missing': str(target / 'missing.zip')}
(state / 'fixtures.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
print(json.dumps({'created': len(records), 'synthetic': True}))
