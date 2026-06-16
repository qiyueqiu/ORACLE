/**
 * Logger 单元测试（ESM + TypeScript）
 */
import { expect } from 'chai';
import { child, ApiError } from '../src/logger.js';

describe('agents/logger', function () {
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(function () {
    stdoutBuf = [];
    stderrBuf = [];
    stdoutWrite = process.stdout.write.bind(process.stdout);
    stderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutBuf.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(function () {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  });

  describe('child()', function () {
    it('Should create a logger with component context', function () {
      const log = child({ component: 'test-component' });
      expect(log).to.have.property('debug');
      expect(log).to.have.property('info');
      expect(log).to.have.property('warn');
      expect(log).to.have.property('error');
      expect(log).to.have.property('fatal');
    });

    it('Should emit JSON with component field', function () {
      const log = child({ component: 'router' });
      log.info('test event', { taskId: 'abc' });
      const out = stdoutBuf.join('');
      const parsed = JSON.parse(out.trim());
      expect(parsed.component).to.equal('router');
      expect(parsed.event).to.equal('test event');
      expect(parsed.taskId).to.equal('abc');
      expect(parsed.level).to.equal('info');
      expect(parsed.ts).to.be.a('string');
    });

    it("Should default component to 'oracle'", function () {
      const log = child();
      log.info('x');
      const parsed = JSON.parse(stdoutBuf.join('').trim());
      expect(parsed.component).to.equal('oracle');
    });
  });

  describe('log levels', function () {
    it('Should route error/fatal to stderr, others to stdout', function () {
      const log = child({ component: 't' });
      log.info('info event');
      log.error('error event');
      log.fatal('fatal event');

      const stdout = stdoutBuf.join('');
      const stderr = stderrBuf.join('');
      expect(stdout).to.include('info event');
      expect(stdout).to.not.include('error event');
      expect(stderr).to.include('error event');
      expect(stderr).to.include('fatal event');
    });
  });

  describe('ApiError', function () {
    it('Should construct with message, statusCode, code, details', function () {
      const e = new ApiError('bad input', 400, 'BAD_INPUT', { field: 'x' });
      expect(e).to.be.instanceof(Error);
      expect(e.message).to.equal('bad input');
      expect(e.statusCode).to.equal(400);
      expect(e.code).to.equal('BAD_INPUT');
      expect(e.details).to.deep.equal({ field: 'x' });
    });

    it('Should default statusCode to 500 and code to INTERNAL_ERROR', function () {
      const e = new ApiError('oops');
      expect(e.statusCode).to.equal(500);
      expect(e.code).to.equal('INTERNAL_ERROR');
      expect(e.details).to.be.undefined;
    });
  });
});
