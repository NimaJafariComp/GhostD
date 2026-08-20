import { describe, expect, it } from 'vitest';

import { desktopHostContract, desktopHostContracts } from '../src/ecosystem/host-contracts.js';

describe('desktop host contract registry', () => {
  it('makes unverified desktop capture explicit while retaining safe handoff paths', () => {
    expect(desktopHostContracts.map(({ id }) => id)).toEqual(['jetbrains', 'zed', 'other-desktop']);
    for (const contract of desktopHostContracts) {
      expect(contract).toMatchObject({ sourceCapture: 'unsupported', activeSessionAwareness: 'unsupported' });
      expect(contract.safeHandoffs).toEqual(['ghost context', 'ghost mcp', 'ghost acp handoff']);
      expect(contract.reason).toMatch(/no (verified )?public observer/i);
    }
  });

  it('rejects unknown host identifiers rather than guessing an integration', () => {
    expect(() => desktopHostContract('unknown' as never)).toThrow('Unknown desktop host');
  });
});
