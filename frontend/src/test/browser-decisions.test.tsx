import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionProvider, useDecisions } from '@/components/DecisionProvider';
import { Button } from '@/components/ui/button';
import { decisionStorageKey, readBrowserDecisions, saveBrowserDecision } from '@/lib/browser-decisions';
import { pendingPriority, priorityQueue } from '@/lib/operations';

function Submission() {
  const { submit, decisions, loading } = useDecisions();
  const item = priorityQueue[0];
  if (!item) throw new Error('Expected supplied forecast');
  return <><Button disabled={loading} onClick={() => void submit(item.id, 'automatic')}>Submit</Button><output>{decisions.length}</output></>;
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('No-account decisions', () => {
  it('submits without a session and restores the decision after remount', async () => {
    const view = render(<DecisionProvider><Submission /></DecisionProvider>);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1'));
    const rows = readBrowserDecisions(localStorage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('user_id');
    expect(pendingPriority(priorityQueue, rows)).toHaveLength(priorityQueue.length - 1);
    view.unmount();
    render(<DecisionProvider><Submission /></DecisionProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('1');
  });
  it('does not remove an item when browser saving fails', () => {
    const item = priorityQueue[0];
    if (!item) throw new Error('Expected supplied forecast');
    const storage = {getItem: () => null, setItem: () => {throw new DOMException('Storage blocked', 'SecurityError');}};
    expect(() => saveBrowserDecision(storage, item.id, 'automatic')).toThrow('Storage blocked');
    expect(localStorage.getItem(decisionStorageKey)).toBeNull();
  });
});