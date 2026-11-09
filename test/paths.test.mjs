import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkspace} from '../packages/windows-paths/index.mjs';
test('Windows paths preserve spaces Chinese and UNC roots',()=>{assert.equal(normalizeWorkspace('C:/Users/用户/My Project/../项目'),'C:\\Users\\用户\\项目');assert.equal(normalizeWorkspace('\\\\server\\share\\文件'),'\\\\server\\share\\文件');});
test('reject relative drive-relative and Linux paths',()=>{for(const p of ['relative','C:relative','/mnt/c/project','\\root','C:\\bad\0']) assert.throws(()=>normalizeWorkspace(p));});
