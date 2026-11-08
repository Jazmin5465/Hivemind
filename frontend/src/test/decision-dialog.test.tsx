import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Button } from '@/components/ui/button';

afterEach(cleanup);

function PopupFixture() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('automatic');
  return <>
    <Button onClick={() => setOpen(true)}>Evaluate</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Decision</DialogTitle>
        <DialogDescription>Comparison</DialogDescription>
        <RadioGroup value={choice} onValueChange={setChoice}>
          <RadioGroupItem value="automatic" aria-label="Automatic" />
          <RadioGroupItem value="trucks" aria-label="Trucks" />
        </RadioGroup>
      </DialogContent>
    </Dialog>
  </>;
}

describe('Decision popup React integration', () => {
  it('mounts, selects, closes and reopens without a hook dispatcher crash', () => {
    render(<PopupFixture />);
    fireEvent.click(screen.getByRole('button', {name:'Evaluate'}));
    fireEvent.click(screen.getByRole('radio', {name:'Trucks'}));
    expect(screen.getByRole('radio', {name:'Trucks'})).toBeChecked();
    fireEvent.click(screen.getByRole('button', {name:'Close'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Evaluate'}));
    expect(screen.getByRole('radio', {name:'Trucks'})).toBeChecked();
  });
});