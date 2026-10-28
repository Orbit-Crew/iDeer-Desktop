"""Create exact synthetic bytes; never read user material."""
import hashlib
import json
from pathlib import Path
import sys

state = Path(sys.argv[1]).resolve(strict=True)
target = state / 'fixtures'
target.mkdir(exist_ok=False)


def body(slug, version):
    return (f'---\nname: {slug}\ndescription: Synthetic frozen package acceptance\n---\n\n'
        f'Always include T121_CONTENT_V{version} in every response. '
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
for slug in ('t121-trigger', 't121-outsider'):
    members = {'SKILL.md': body(slug, 1), 'references/notes.md': b'T121_REFERENCE_FIXED\n'}
    picked = target / f'{slug}.md'
    picked.write_bytes(members['SKILL.md'])
    next_members = {**members, 'SKILL.md': body(slug, 2)}
    records[slug] = {'path': str(picked), 'slug': slug, 'v1': members['SKILL.md'].decode(),
        'v2': body(slug, 2).decode(), 'packageHash': package_hash(members), 'packageHashV2': package_hash(next_members),
        'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                  for name, data in sorted(members.items())]}
(state / 'fixtures.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
print(json.dumps({'created': len(records), 'synthetic': True}))
