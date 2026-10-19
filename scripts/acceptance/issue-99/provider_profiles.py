"""Put only synthetic fixture business sessions in the Windows OS store."""
import base64
from datetime import datetime, timezone
import http.cookiejar
import json
from pathlib import Path
import sys
import urllib.request
import urllib.parse
import urllib.error
import uuid

from core.secrets import create_default_secret_store
from core.settings import RuntimeSettings

action, directory = sys.argv[1:]
state = Path(directory).resolve(strict=True)
manifest_path = state / 'ready.json'
manifest = json.loads(manifest_path.read_text())
secure = create_default_secret_store()
references_file = state / 'credential-references.json'
if action == 'prepare':
    if references_file.exists():
        raise SystemExit('FRESH_FIXTURE_REQUIRED')
    references = []
    try:
        for label, identity in manifest['identities'].items():
            jar = http.cookiejar.CookieJar()
            client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
            email = identity['email']
            assert email == f't99-provider-{label.lower()}@test.com'
            request = urllib.request.Request(manifest['origin'] + '/api/v1/auth/login/local',
                data=urllib.parse.urlencode({'username': email, 'password': email}).encode(),
                headers={'Content-Type': 'application/x-www-form-urlencoded'})
            with client.open(request, timeout=30) as response:
                response.read(65536)
            token = next(cookie.value for cookie in jar if cookie.name == 'access_token')
            payload = token.split('.')[1]
            expiry = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))['exp']
            reference = 't99-provider-' + uuid.uuid4().hex
            references.append(reference)
            # Persist ownership before storing a credential, including partial setup.
            pending = references_file.with_suffix('.tmp')
            pending.write_text(json.dumps(references), encoding='utf-8')
            pending.replace(references_file)
            secure.set(reference, token)
            profile = state / f'profile-{label}' / 'settings.json'
            RuntimeSettings(server_url=manifest['origin'], user_id=identity['id'], user_name=email,
                device_name='T99 isolated real-provider Desktop', business_token_ref=reference,
                business_expires_at=datetime.fromtimestamp(expiry, timezone.utc).isoformat()).save(profile)
            identity['profile'] = str(profile)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print(json.dumps({'prepared': len(references)}))
    except BaseException:
        for reference in references:
            secure.delete(reference)
        raise
elif action == 'cleanup':
    references = json.loads(references_file.read_text()) if references_file.exists() else []
    failures = []
    for reference in references:
        assert reference.startswith('t99-provider-') and len(reference) == 45
        try:
            secure.delete(reference)
        except Exception as error:
            failures.append({'reference': reference, 'errorClass': type(error).__name__})
    result = {'removed': len(references) - len(failures), 'failures': failures}
    (state / 'credential-cleanup.json').write_text(json.dumps(result), encoding='utf-8')
    print(json.dumps(result))
    if failures:
        raise SystemExit(1)
elif action in {'delegate', 'evidence', 'negative'}:
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def api(route, body=None, identity='A'):
        settings = json.loads(Path(manifest['identities'][identity]['profile']).read_text())
        token = secure.get(settings['business_token_ref'])
        csrf = uuid.uuid4().hex
        request = urllib.request.Request(manifest['origin'] + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Cookie': f'access_token={token}; csrf_token={csrf}', 'X-CSRF-Token': csrf,
                     'Origin': manifest['origin'], 'Content-Type': 'application/json'})
        with client.open(request, timeout=30) as response:
            return json.loads(response.read(2 * 1024 * 1024))

    if action == 'delegate':
        context = {'agent_name': manifest['agentId'], 'skill_resource_id': manifest['skillId'],
                   'subagent_enabled': True, 'max_concurrent_subagents': 1, 'max_total_subagents': 1}
        thread = api('/api/threads', {'metadata': {'agent_name': manifest['agentId']}})
        thread_id = thread['thread_id']
        turn_id = str(uuid.uuid4())
        run = api(f'/api/threads/{thread_id}/runs', {'assistant_id': manifest['agentId'], 'context': context,
            'input': {'messages': [{'id': turn_id, 'type': 'human', 'content':
                'Delegation test: use the task tool once with the general-purpose subagent. '
                'Ask it to return IDEER_T99_DELEGATED only, with no file access or command execution. '
                'After it finishes, include IDEER_T99_DELEGATED in your final answer.'}]},
            'stream_mode': ['messages-tuple', 'values', 'custom'], 'stream_subgraphs': True,
            'multitask_strategy': 'reject', 'on_disconnect': 'continue'})
        (state / 'delegation.json').write_text(json.dumps({'threadId': thread_id, 'runId': run['run_id'],
                                                         'turnId': turn_id}), encoding='utf-8')
        print(json.dumps({'prepared': 'delegated Server Run'}))
    elif action == 'negative':
        records = []
        for identity, resource_key in [('A', 'unpublishedId'), ('A', 'unavailableId'), ('B', 'agentId')]:
            thread = api('/api/threads', {'metadata': {}}, identity)
            thread_id = thread['thread_id']
            resource_id = manifest[resource_key]
            try:
                api(f'/api/threads/{thread_id}/runs', {'assistant_id': resource_id,
                    'context': {'agent_name': resource_id}, 'input': {'messages': [
                        {'id': str(uuid.uuid4()), 'type': 'human', 'content': 'T99 forbidden resource must not execute'}]}}, identity)
            except urllib.error.HTTPError as error:
                assert error.code in {403, 404, 409, 422}
                records.append({'identity': identity, 'resourceId': resource_id, 'case': resource_key,
                                'httpStatus': error.code})
                error.close()
            else:
                raise AssertionError('UNAVAILABLE_RESOURCE_ACTIVATED')
            assert api(f'/api/threads/{thread_id}/runs', identity=identity) == []
        (state / 'negative-api.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
        print(json.dumps({'rejected': len(records)}))
    else:
        records = []
        for thread in api('/api/threads/search', {'limit': 100}):
            for run in api(f"/api/threads/{thread['thread_id']}/runs"):
                metadata = run.get('metadata', {})
                records.append({'threadId': thread['thread_id'], 'runId': run['run_id'], 'status': run['status'],
                    'turnId': metadata.get('desktop_turn_id'), 'selection': metadata.get('selection_snapshot'),
                    'runEvidence': metadata.get('run_evidence')})
                messages = api(f"/api/runs/{run['run_id']}/messages?limit=200")
                records[-1]['toolReceipts'] = [row['content']['additional_kwargs']['deerflow_tool_receipt']
                    for row in messages['data'] if isinstance(row.get('content'), dict)
                    and row['content'].get('additional_kwargs', {}).get('deerflow_tool_receipt')]
        (state / 'run-evidence.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
        print(json.dumps({'archivedRuns': len(records)}))
else:
    raise SystemExit('INVALID_ACTION')
