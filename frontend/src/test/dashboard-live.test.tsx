// The dashboard on a fake live store: queue from backend rows, popup asks the backend for options,
// Submit approves the chosen backend plan (or sends an inspector for a leak).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '@/components/LiveProvider';
import type { LiveData, LiveStore } from '@/lib/live/store';
import { Route } from '@/routes/index';
import { action, event, facility, liveData, plan, planFacility, state, system, ts } from './live-fixtures';

afterEach(cleanup);

function fakeStore(initial: LiveData) {
  let snap = initial;
  const listeners = new Set<() => void>();
  const set = (next: LiveData) => {
    snap = next;
    listeners.forEach((l) => l());
  };
  const reducers = {
    requestPlanOptions: vi.fn(async () => {
      // the module answers by inserting option plans; emulate that
      set({
        ...snap,
        plans: [
          plan(1n, 'S1', { optionKey: 'optimal', totalCost: 905, eventIds: ['e-fail'], createdAt: ts(9n) }),
          plan(2n, 'S1', { optionKey: 'do_nothing', totalCost: 5016, eventIds: ['e-fail'], createdAt: ts(9n) }),
        ],
        planActions: [action(1n, 'S1_FACILITY_A', 'dispatch_truck', { trucks: 1, tripsPerTruck: 1 })],
        planFacilities: [planFacility(1n, 'S1_FACILITY_A'), planFacility(2n, 'S1_FACILITY_A', { cost: 5016, truckCost: 0, tripCost: 5016, tripsAtUnix: snap.clock!.nowUnix + 3600 })],
      });
    }),
    approvePlan: vi.fn(async () => {}),
    selectContingency: vi.fn(async () => {}),
    sendInspector: vi.fn(async () => {}),
  };
  const store = { subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)), getSnapshot: () => snap, reducers } as unknown as LiveStore;
  return { store, reducers };
}

const base = () =>
  liveData({
    systems: [system('S1')],
    facilities: [facility('S1_FACILITY_A', 'S1'), facility('S1_FACILITY_B', 'S1')],
    opsSystems: [{ key: 'k', datasetId: 'fixture', systemId: 'S1', fleetSize: 2 } as never],
    facilityStates: [state('S1_FACILITY_A', 'S1', 60, 2400), state('S1_FACILITY_B', 'S1', 40, 2400)],
    events: [
      event('e-fail', 'S1_FACILITY_A', 'S1', 'pump_failure', { alertRank: 1, hoursToLimitP50: 2 }),
      event('e-leak', 'S1_FACILITY_B', 'S1', 'pipeline_leak', { alertRank: 2 }),
    ],
  });

const Dashboard = Route.options.component as () => React.ReactElement;

describe('dashboard on live data', () => {
  it('shows backend alerts with the backend countdown', () => {
    const { store } = fakeStore(base());
    render(<LiveProvider store={store}><Dashboard /></LiveProvider>);
    expect(screen.getByRole('button', { name: 'Evaluate S1_FACILITY_A — Pump failure' })).toHaveTextContent('02:00:00');
    expect(screen.getByRole('button', { name: 'Evaluate S1_FACILITY_B — Pipeline leak' })).toHaveTextContent('Active leak');
  });

  it('popup requests backend options and Submit approves the optimal plan', async () => {
    const { store, reducers } = fakeStore(base());
    render(<LiveProvider store={store}><Dashboard /></LiveProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate S1_FACILITY_A — Pump failure' }));
    await waitFor(() => expect(reducers.requestPlanOptions).toHaveBeenCalledWith({ datasetId: 'fixture', systemId: 'S1', facilityId: undefined }));
    expect(await screen.findByText('$905')).toBeInTheDocument();
    expect(screen.getByText('$5,016')).toBeInTheDocument();
    expect(screen.getByText(/Optimal · lowest cost/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Submit' })));
    expect(reducers.approvePlan).toHaveBeenCalledWith({ planId: 1n });
  });

  it('leak popup sends an inspector', async () => {
    const { store, reducers } = fakeStore(base());
    render(<LiveProvider store={store}><Dashboard /></LiveProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate S1_FACILITY_B — Pipeline leak' }));
    expect(reducers.requestPlanOptions).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Submit' })));
    expect(reducers.sendInspector).toHaveBeenCalledWith({ eventId: 'e-leak', note: '' });
  });
});
