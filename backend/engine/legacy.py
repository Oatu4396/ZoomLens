import asyncio
import json
import os
from pathlib import Path

WORKER = Path(__file__).with_name('worker.cjs')


class CalculationError(Exception):
    pass


class LegacyEngine:
    def __init__(self):
        self.slots = asyncio.Semaphore(int(os.environ.get('ZOOMLENS_WORKERS', '2')))
        self.timeout = float(os.environ.get('ZOOMLENS_TIMEOUT', '120'))

    async def stream(self, operation, document):
        process = None
        async with self.slots:
            try:
                async with asyncio.timeout(self.timeout):
                    process = await asyncio.create_subprocess_exec(
                        'node', str(WORKER), operation,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        limit=16 * 1024 * 1024,
                    )
                    process.stdin.write(json.dumps({'document': document}).encode())
                    await process.stdin.drain()
                    process.stdin.close()
                    async for line in process.stdout:
                        result = json.loads(line)
                        if 'error' in result:
                            raise CalculationError(result['error'])
                        yield result
                    if await process.wait():
                        raise CalculationError('The optical engine stopped unexpectedly.')
            except TimeoutError as error:
                raise CalculationError('Calculation timed out.') from error
            finally:
                if process is not None and process.returncode is None:
                    process.kill()
                    await process.wait()

    async def layout(self, document):
        result = None
        async for record in self.stream('layout', document):
            result = record
        if result is None:
            raise CalculationError('The optical engine returned no layout.')
        return result
