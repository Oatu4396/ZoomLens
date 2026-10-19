import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

base = os.environ.get('ZOOMLENS_URL', 'http://127.0.0.1:8080')
fixtures = json.loads(Path(__file__).with_name('fixtures.json').read_text())
design = next(case['document'] for case in fixtures if case['name'] == 'ideal')

with urlopen(base + '/api/health', timeout=10) as response:
    assert json.load(response)['status'] == 'ok'
with urlopen(base + '/', timeout=10) as response:
    assert b'id="zoomTabButton"' in response.read()
for route in ['layout', 'performance']:
    request = Request(base + '/api/' + route,
                      data=json.dumps({'document': design}).encode(),
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=120) as response:
        if route == 'layout':
            assert json.load(response)['firstOrder'][0][1] == 50
        else:
            assert [json.loads(line)['stage'] for line in response if line.strip()] == [
                'coefficients', 'fans', 'field', 'spot', 'mtf']
print('Container frontend, layout API, and streamed performance API passed.')
