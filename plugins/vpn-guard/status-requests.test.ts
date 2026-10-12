import {expect,it} from 'vitest';
import {createStatusRequests} from './status-requests.js';
import {readableError} from './copy.js';

it('rejects a delayed older read after the newest external block snapshot',()=>{
  const requests=createStatusRequests();
  const old=requests.start();const newest=requests.start();
  expect(requests.isCurrent(newest)).toBe(true);
  expect(requests.isCurrent(old)).toBe(false);
  requests.invalidate();expect(requests.isCurrent(newest)).toBe(false);
  expect(requests.isCurrent(requests.start())).toBe(true);
});
it('shows a Russian explanation for unknown technical errors',()=>{
  expect(readableError('Error: threads.listRunning: service unavailable','ru')).toBe('Не удалось выполнить действие. Проверьте подробности ошибки.');
  expect(readableError('Error: threads.listRunning: service unavailable','en')).toBe('Action failed. Check the error details.');
});
