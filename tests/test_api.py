import asyncio
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import app
from backend.engine.legacy import CalculationError, LegacyEngine

FIXTURES = json.loads(Path(__file__).with_name('fixtures.json').read_text())
IDEAL = next(case['document'] for case in FIXTURES if case['name'] == 'ideal')


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.context = TestClient(app)
        self.client = self.context.__enter__()

    def tearDown(self):
        self.context.__exit__(None, None, None)

    def test_frontend_and_api_routes(self):
        self.assertEqual(self.client.get('/api/health').json()['status'], 'ok')
        page = self.client.get('/')
        self.assertEqual(page.status_code, 200)
        self.assertIn('id="zoomTabButton"', page.text)
        self.assertIn('>Design</button>', page.text)
        self.assertNotIn('Design/Zoom', page.text)
        for url in ['/app.js', '/styles.css', '/shared/optics.js', '/shared/catalogs.js', '/shared/examples.js']:
            self.assertEqual(self.client.get(url).status_code, 200, url)
        self.assertEqual(self.client.get('/backend/app.py').status_code, 404)

    def test_layout_and_invalid_document(self):
        result = self.client.post('/api/layout', json={'document': IDEAL})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['firstOrder'][0][1], 50)
        self.assertEqual(self.client.post('/api/layout', json={'document': {}}).status_code, 422)

    def test_streamed_performance_stages(self):
        with self.client.stream('POST', '/api/performance', json={'document': IDEAL}) as response:
            self.assertIn('application/x-ndjson', response.headers['content-type'])
            stages = [json.loads(line) for line in response.iter_lines() if line]
        self.assertEqual([stage['stage'] for stage in stages], ['coefficients', 'fans', 'field', 'spot', 'mtf'])
        self.assertTrue(stages[-1]['data']['fields'][0]['waves'][0]['T'])
        response = self.client.post('/api/performance', json={'document': {}})
        self.assertIn('error', json.loads(response.text))


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_designs_are_isolated(self):
        engine = LegacyEngine()
        other = copy.deepcopy(IDEAL)
        other['specifications']['epd'] = 2
        first, second = await asyncio.gather(engine.layout(IDEAL), engine.layout(other))
        self.assertEqual(first['aperture']['epd'], 10)
        self.assertEqual(second['aperture']['epd'], 2)

    async def test_timeout_and_cancellation_stop_child(self):
        engine = LegacyEngine()
        children = []
        create = asyncio.create_subprocess_exec

        async def capture(*args, **kwargs):
            child = await create(*args, **kwargs)
            children.append(child)
            return child

        with patch('asyncio.create_subprocess_exec', capture):
            engine.timeout = .01
            with self.assertRaises(CalculationError):
                await engine.layout(IDEAL)
            self.assertIsNotNone(children[-1].returncode)
            engine.timeout = 120
            task = asyncio.create_task(engine.layout(IDEAL))
            while len(children) < 2:
                await asyncio.sleep(.001)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNotNone(children[-1].returncode)


if __name__ == '__main__':
    unittest.main()
