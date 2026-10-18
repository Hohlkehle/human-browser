/**
 * Stage 6 unit tests: the human-control state machine
 * (ready / running / human_required / waiting_for_user / resuming / failed).
 */
import { describe, expect, it, vi } from 'vitest';
import { createHumanGate } from '../../src/human/gate.js';

describe('createHumanGate (Stage 6 state machine)', () => {
  it('starts ready and unpaused', () => {
    const gate = createHumanGate();
    expect(gate.state()).toBe('ready');
    expect(gate.isPaused()).toBe(false);
    expect(gate.snapshot()).toEqual({ state: 'ready' });
    gate.dispose();
  });

  it('rejects a non-positive timeout', () => {
    expect(() => createHumanGate({ timeoutMs: 0 })).toThrowError(/timeoutMs/);
    expect(() => createHumanGate({ timeoutMs: -5 })).toThrowError(/timeoutMs/);
  });

  it('tracks running operations: ready -> running -> ready', () => {
    const gate = createHumanGate();
    gate.operationStarted();
    expect(gate.state()).toBe('running');
    // Concurrent operations are counted.
    gate.operationStarted();
    gate.operationFinished();
    expect(gate.state()).toBe('running');
    gate.operationFinished();
    expect(gate.state()).toBe('ready');
    // Finishing more than started is harmless.
    gate.operationFinished();
    expect(gate.state()).toBe('ready');
    gate.dispose();
  });

  it('challengeDetected: ready -> human_required with full pause info', () => {
    const gate = createHumanGate({ clock: () => new Date('2026-01-02T03:04:05.000Z') });
    const snapshot = gate.challengeDetected({
      reason: 'Probable reCAPTCHA challenge detected on allowed.test',
      pageId: 'page-2',
      kind: 'challenge',
      hostname: 'allowed.test',
      provider: 'reCAPTCHA',
    });
    expect(gate.state()).toBe('human_required');
    expect(gate.isPaused()).toBe(true);
    expect(snapshot).toMatchObject({
      state: 'human_required',
      reason: 'Probable reCAPTCHA challenge detected on allowed.test',
      pageId: 'page-2',
      kind: 'challenge',
      hostname: 'allowed.test',
      provider: 'reCAPTCHA',
      pausedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(snapshot.timeoutAt).toBeDefined();
    gate.dispose();
  });

  it('the first pause wins: a later detection cannot clobber the wait', () => {
    const gate = createHumanGate();
    gate.challengeDetected({ reason: 'first', pageId: 'page-1', kind: 'challenge' });
    const second = gate.challengeDetected({ reason: 'second', pageId: 'page-9' });
    expect(second.reason).toBe('first');
    expect(second.pageId).toBe('page-1');
    gate.dispose();
  });

  it('pause: ready -> waiting_for_user (manual handover)', () => {
    const gate = createHumanGate();
    const snapshot = gate.pause({ reason: 'login required', pageId: 'page-3' });
    expect(snapshot).toMatchObject({
      state: 'waiting_for_user',
      reason: 'login required',
      pageId: 'page-3',
      kind: 'manual',
    });
    expect(gate.isPaused()).toBe(true);
    gate.dispose();
  });

  it('pause acknowledges a detected challenge and keeps the original reason', () => {
    const gate = createHumanGate();
    gate.challengeDetected({ reason: 'challenge reason', pageId: 'page-1', kind: 'challenge' });
    const snapshot = gate.pause({ reason: 'model reason', pageId: 'page-9' });
    expect(snapshot.state).toBe('waiting_for_user');
    expect(snapshot.reason).toBe('challenge reason');
    expect(snapshot.pageId).toBe('page-1');
    expect(snapshot.kind).toBe('challenge');
    gate.dispose();
  });

  it('resume flow: beginResume -> resuming -> completeResume -> ready (info cleared)', () => {
    const gate = createHumanGate();
    gate.pause({ reason: 'login', pageId: 'page-1' });
    expect(gate.beginResume().state).toBe('resuming');
    expect(gate.isPaused()).toBe(true);
    expect(gate.completeResume()).toEqual({ state: 'ready' });
    expect(gate.isPaused()).toBe(false);
    expect(gate.snapshot()).toEqual({ state: 'ready' });
    gate.dispose();
  });

  it('abortResume returns to waiting_for_user with a fresh deadline', () => {
    const gate = createHumanGate();
    gate.pause({ reason: 'challenge', pageId: 'page-1', kind: 'challenge' });
    gate.beginResume();
    const snapshot = gate.abortResume();
    expect(snapshot.state).toBe('waiting_for_user');
    expect(snapshot.timeoutAt).toBeDefined();
    expect(gate.isPaused()).toBe(true);
    gate.dispose();
  });

  it('times out into failed and invokes onTimeout', async () => {
    const onTimeout = vi.fn();
    const gate = createHumanGate({ timeoutMs: 25, onTimeout });
    gate.pause({ reason: 'login', pageId: 'page-1' });
    await vi.waitFor(() => {
      expect(gate.state()).toBe('failed');
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[0]).toMatchObject({ state: 'failed', pageId: 'page-1' });
    // Failed still blocks automation.
    expect(gate.isPaused()).toBe(true);
    gate.dispose();
  });

  it('a completed resume cancels the timeout', async () => {
    const onTimeout = vi.fn();
    const gate = createHumanGate({ timeoutMs: 25, onTimeout });
    gate.pause({ reason: 'quick' });
    gate.beginResume();
    gate.completeResume();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(gate.state()).toBe('ready');
    expect(onTimeout).not.toHaveBeenCalled();
    gate.dispose();
  });

  it('failed -> pause starts a fresh wait round', async () => {
    const gate = createHumanGate({ timeoutMs: 25 });
    gate.pause({ reason: 'login', pageId: 'page-1' });
    await vi.waitFor(() => expect(gate.state()).toBe('failed'));
    const snapshot = gate.pause({ reason: 'second attempt', pageId: 'page-2' });
    expect(snapshot.state).toBe('waiting_for_user');
    expect(snapshot.reason).toBe('second attempt');
    expect(snapshot.timeoutAt).toBeDefined();
    gate.dispose();
  });

  it('failed -> beginResume -> completeResume recovers', async () => {
    const gate = createHumanGate({ timeoutMs: 25 });
    gate.pause({ reason: 'login', pageId: 'page-1' });
    await vi.waitFor(() => expect(gate.state()).toBe('failed'));
    expect(gate.beginResume().state).toBe('resuming');
    expect(gate.completeResume().state).toBe('ready');
    gate.dispose();
  });

  it('operation tracking is ignored while paused', () => {
    const gate = createHumanGate();
    gate.pause({ reason: 'x' });
    gate.operationStarted();
    expect(gate.state()).toBe('waiting_for_user');
    gate.operationFinished();
    expect(gate.state()).toBe('waiting_for_user');
    gate.dispose();
  });

  it('challengeDetected while running stops the run', () => {
    const gate = createHumanGate();
    gate.operationStarted();
    expect(gate.state()).toBe('running');
    gate.challengeDetected({ reason: 'challenge', pageId: 'page-1' });
    expect(gate.state()).toBe('human_required');
    // The in-flight operation finishes without returning to ready.
    gate.operationFinished();
    expect(gate.state()).toBe('human_required');
    gate.dispose();
  });

  it('dispose clears the wait timer', async () => {
    const onTimeout = vi.fn();
    const gate = createHumanGate({ timeoutMs: 25, onTimeout });
    gate.pause({ reason: 'x' });
    gate.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(gate.state()).toBe('waiting_for_user');
  });

  it('beginResume/completeResume are no-ops when ready', () => {
    const gate = createHumanGate();
    expect(gate.beginResume()).toEqual({ state: 'ready' });
    expect(gate.completeResume()).toEqual({ state: 'ready' });
    expect(gate.abortResume()).toEqual({ state: 'ready' });
    gate.dispose();
  });

  it('truncates overly long pause reasons', () => {
    const gate = createHumanGate();
    const snapshot = gate.pause({ reason: 'r'.repeat(2_000) });
    expect(snapshot.reason?.length).toBe(500);
    gate.dispose();
  });
});
