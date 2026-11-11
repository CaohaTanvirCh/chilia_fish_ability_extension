import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StoreV3,
  STORE_V3_INTERNAL_COMMIT,
} from '../packages/task-store-v3/index.mjs';
import {
  assertAuthorityRevocationFence,
  assertAuthorizationContext,
  assertBootstrapState,
  assertDelegationGrant,
  assertDomainEvent,
  assertFenceUsable,
  assertMembershipInvite,
  assertMembershipRevision,
  assertPrincipal,
  assertRequestRecord,
  assertWorkspace,
  assertWorkspaceMember,
  canonicalSourceKey,
  computeRequestScopeHash,
  effectiveMembershipStatus,
  parseCanonicalSourceKey,
  validateStoreV3IdentityState,
} from '../packages/contracts/v3.mjs';

const INTERNAL = STORE_V3_INTERNAL_COMMIT;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

function user(principalId = 'prn_owner', overrides = {}) {
  return {
    principalId,
    principalType: 'user',
    displayName: 'User',
    status: 'active',
    deletedAt: null,
    disabledAt: null,
    disabledReason: null,
    createdByPrincipalId: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...overrides,
  };
}
function agent(principalId = 'prn_agent', overrides = {}) {
  return {
    principalId,
    principalType: 'agent',
    displayName: 'Agent',
    status: 'active',
    deletedAt: null,
    disabledAt: null,
    disabledReason: null,
    createdByPrincipalId: 'prn_owner',
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    agentProfile: { registeredByPrincipalId: 'prn_owner', connectorKind: 'local', capabilities: ['task:read'] },
    ...overrides,
  };
}
function system(principalId = 'system:migration', overrides = {}) {
  return {
    principalId,
    principalType: 'system',
    displayName: null,
    status: 'active',
    deletedAt: null,
    disabledAt: null,
    disabledReason: null,
    createdByPrincipalId: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...overrides,
  };
}
function workspace(workspaceId = 'ws_1', ownerPrincipalId = 'prn_owner', overrides = {}) {
  return {
    workspaceId,
    name: 'Workspace',
    status: 'active',
    ownerPrincipalId,
    rootStatus: 'bound',
    rootRef: 'root-ref',
    rootPath: 'C:\\work',
    rootIdentity: { volumeSerial: 'vol', fileId: 'file', finalPath: 'C:\\work', observedAt: T0 },
    workspaceBoundaryEnforcement: 'cooperative',
    quarantineState: 'normal',
    quarantineReason: null,
    quarantinedAt: null,
    isolationPolicy: 'mutex',
    governanceState: 'normal',
    writeEpoch: 0,
    policyVersion: 1,
    createdByPrincipalId: ownerPrincipalId,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    deletedAt: null,
    deletedFrom: null,
    ...overrides,
  };
}
function member(principalId, role, revisionId, version = 1, status = 'active', overrides = {}) {
  return {
    workspaceId: 'ws_1',
    principalId,
    role,
    status,
    version,
    lastMembershipRevisionId: revisionId,
    grantedByPrincipalId: 'prn_owner',
    grantedAt: T0,
    updatedAt: T0,
    revokedAt: status === 'revoked' ? T1 : null,
    revokedReason: status === 'revoked' ? 'removed' : null,
    ...overrides,
  };
}
function revision(revisionId, principalId, role, version = 1, storedStatus = 'active', overrides = {}) {
  return {
    membershipRevisionId: revisionId,
    workspaceId: 'ws_1',
    principalId,
    version,
    storedStatus,
    role,
    actorPrincipalId: 'prn_owner',
    time: T0,
    reason: null,
    previousRevisionId: null,
    ...overrides,
  };
}
function delegation(overrides = {}) {
  return {
    delegationId: 'dlg_1',
    workspaceId: 'ws_1',
    grantorPrincipalId: 'prn_owner',
    delegatePrincipalId: 'prn_agent',
    scopes: ['task:read', 'task:control'],
    resourceScope: { kind: 'workspace' },
    status: 'active',
    version: 1,
    grantorPrincipalVersion: 1,
    grantorMembershipVersion: 1,
    delegatePrincipalVersion: 1,
    delegateMembershipVersion: 1,
    parentDelegationId: null,
    createdAt: T0,
    expiresAt: T1,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...overrides,
  };
}
function invite(overrides = {}) {
  return {
    inviteId: 'inv_1',
    workspaceId: 'ws_1',
    targetPrincipalId: 'prn_agent',
    role: 'operator',
    tokenHash: 'token-hash',
    status: 'pending',
    createdByPrincipalId: 'prn_owner',
    createdAt: T0,
    expiresAt: T1,
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}
function fence(overrides = {}) {
  return {
    fenceId: 'fence_1',
    sourceKind: 'principal',
    sourceKey: canonicalSourceKey('principal', 'prn_disabled'),
    sourceVersion: 1,
    scope: { kind: 'global', workspaceId: null },
    principalId: 'prn_disabled',
    delegationId: null,
    cause: 'disabled',
    effectiveAt: T1,
    authorizationRevision: 0,
    status: 'completed',
    processedTaskIds: [],
    processedGrantIds: [],
    lastError: null,
    quarantineReason: null,
    diagnostics: [],
    createdAt: T1,
    completedAt: T1,
    ...overrides,
  };
}
function event(overrides = {}) {
  return {
    scope: 'system',
    workspaceId: null,
    type: 'contracts.test',
    schemaVersion: 1,
    source: 'system',
    audience: 'system',
    actorPrincipalId: null,
    taskId: null,
    executionId: null,
    artifactId: null,
    correlationId: null,
    causationId: null,
    data: { ok: true },
    ...overrides,
  };
}
function request(overrides = {}) {
  const base = {
    requestRecordId: 'req_1',
    workspaceId: 'ws_1',
    actorPrincipalId: 'prn_owner',
    delegationId: null,
    operation: 'task.create',
    clientRequestKey: 'key-1',
    inputHash: 'b'.repeat(64),
    resultRef: { taskId: 'tsk_1' },
    resultSnapshot: { ok: true },
    resultBytes: Buffer.byteLength(JSON.stringify({ ok: true })),
    authorizationRevision: 0,
    createdAt: T0,
    status: 'committed',
    ...overrides,
  };
  base.scopeHash = computeRequestScopeHash({
    workspaceId: base.workspaceId,
    actorPrincipalId: base.actorPrincipalId,
    delegationId: base.delegationId,
    operation: base.operation,
    clientRequestKey: base.clientRequestKey,
  });
  return base;
}
function seedBase(draft) {
  draft.principals.push(user(), agent());
  draft.workspaces.push(workspace());
  draft.workspaceMembers.push(
    member('prn_owner', 'owner', 'mrev_owner_1'),
    member('prn_agent', 'operator', 'mrev_agent_1'),
  );
  draft.membershipRevisions.push(
    revision('mrev_owner_1', 'prn_owner', 'owner'),
    revision('mrev_agent_1', 'prn_agent', 'operator'),
  );
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-contracts-v3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, stateFile: join(dir, 'state-v3.json'), store: () => new StoreV3(dir).open() };
}
function baseStore(t) {
  const f = fixture(t);
  const store = f.store();
  store[INTERNAL](0, draft => {
    seedBase(draft);
    return [event()];
  });
  return { ...f, makeStore: f.store, store };
}

test('contracts: valid identity state commits through the real Store and reopens', t => {
  const f = baseStore(t);
  const state = f.store.snapshot();
  assert.equal(state.revision, 1);
  assert.equal(state.sequence, 1);
  assert.equal(state.principals.length, 2);
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.workspaceMembers.length, 2);
  assert.equal(state.membershipRevisions.length, 2);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].sequence, 1);
  assert.equal(state.events[0].revision, 1);
  const bytes = readFileSync(f.stateFile, 'utf8');
  f.store.close();
  const reopened = f.makeStore();
  assert.deepEqual(reopened.snapshot(), state);
  assert.equal(readFileSync(f.stateFile, 'utf8'), bytes);
  reopened.close();
});

test('contracts: Principal types, nullable fields, and version rules', () => {
  assert.doesNotThrow(() => assertPrincipal(user()));
  assert.doesNotThrow(() => assertPrincipal(agent()));
  assert.doesNotThrow(() => assertPrincipal(system()));
  assert.throws(() => assertPrincipal({ ...user(), principalType: 'service' }), { code: 'CONTRACT_INVALID_ENUM' });
  assert.throws(() => assertPrincipal({ ...user(), status: 'inactive' }), { code: 'CONTRACT_INVALID_ENUM' });
  assert.throws(() => assertPrincipal({ ...user(), version: 0 }), { code: 'CONTRACT_INVALID_VERSION' });
  assert.throws(() => assertPrincipal({ ...user(), agentProfile: { registeredByPrincipalId: 'prn_owner', connectorKind: 'local', capabilities: [] } }), { code: 'CONTRACT_INVALID_COMBINATION' });
  const missingAgentProfile = agent();
  delete missingAgentProfile.agentProfile;
  assert.doesNotThrow(() => assertPrincipal(missingAgentProfile));
  assert.throws(() => assertPrincipal({ ...system(), principalId: 'prn_system' }), { code: 'CONTRACT_INVALID_ID' });
  assert.throws(() => assertPrincipal({ ...user(), principalId: 'system:fake' }), { code: 'CONTRACT_INVALID_ID' });
  assert.throws(() => assertPrincipal({ ...user(), status: 'disabled', disabledAt: null }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertPrincipal({ ...user(), deletedAt: T1 }), { code: 'CONTRACT_INVALID_COMBINATION' });
});

test('contracts: Workspace root, lifecycle, and quarantine combinations', () => {
  assert.doesNotThrow(() => assertWorkspace(workspace()));
  assert.doesNotThrow(() => assertWorkspace(workspace('ws_2', 'prn_owner', { rootStatus: 'unbound', rootRef: null, rootPath: null, rootIdentity: null })));
  assert.throws(() => assertWorkspace(workspace('ws_2', 'prn_owner', { rootStatus: 'unbound' })), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertWorkspace({ ...workspace(), status: 'archived' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertWorkspace({ ...workspace(), quarantineState: 'quarantined' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertWorkspace({ ...workspace(), deletedFrom: 'live' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertWorkspace({ ...workspace(), rootStatus: 'broken' }), { code: 'CONTRACT_INVALID_ENUM' });
});

test('contracts: membership stored/effective separation and revision binding', () => {
  const memberRecord = member('prn_agent', 'operator', 'mrev_agent_1');
  assert.doesNotThrow(() => assertWorkspaceMember(memberRecord));
  assert.doesNotThrow(() => assertWorkspaceMember(member('prn_agent', 'viewer', 'mrev_agent_1')));
  assert.throws(() => assertWorkspaceMember({ ...memberRecord, effectiveStatus: 'active' }), { code: 'CONTRACT_UNKNOWN_FIELD' });
  assert.throws(() => assertWorkspaceMember({ ...memberRecord, role: 'auditor' }), { code: 'CONTRACT_INVALID_ENUM' });
  assert.throws(() => assertWorkspaceMember({ ...memberRecord, status: 'revoked', revokedAt: null }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.doesNotThrow(() => assertMembershipRevision(revision('mrev_agent_1', 'prn_agent', 'operator')));
  assert.throws(() => assertMembershipRevision(revision('mrev_agent_1', 'prn_agent', 'operator', 0)), { code: 'CONTRACT_INVALID_VERSION' });

  const ws = workspace();
  const owner = user();
  assert.equal(effectiveMembershipStatus(owner, ws, memberRecord), 'active');
  assert.equal(effectiveMembershipStatus({ ...owner, status: 'disabled' }, ws, memberRecord), 'suspended');
  assert.equal(effectiveMembershipStatus({ ...owner, deletedAt: T1, status: 'disabled' }, ws, memberRecord), 'revoked');
  assert.equal(effectiveMembershipStatus(owner, ws, { ...memberRecord, status: 'revoked' }), 'revoked');
  const membershipFence = fence({
    sourceKind: 'membership',
    sourceKey: canonicalSourceKey('membership', 'ws_1', 'prn_agent'),
    scope: { kind: 'workspace', workspaceId: 'ws_1' },
    principalId: 'prn_agent',
    cause: 'revoked',
    sourceVersion: 1,
  });
  assert.equal(effectiveMembershipStatus(owner, ws, memberRecord, [membershipFence]), 'revoked');
  const principalFence = fence({
    sourceKey: canonicalSourceKey('principal', 'prn_owner'),
    principalId: 'prn_owner',
    sourceVersion: 1,
  });
  assert.equal(effectiveMembershipStatus(owner, ws, memberRecord, [principalFence]), 'revoked');
  assert.equal(effectiveMembershipStatus(owner, { ...ws, status: 'archived' }, memberRecord), 'active');
  assert.equal(effectiveMembershipStatus(owner, { ...ws, status: 'deleted' }, memberRecord), 'suspended');
});

test('contracts: System principals cannot hold Workspace membership', t => {
  const f = baseStore(t);
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.principals.push(system());
    draft.workspaceMembers.push(member('system:migration', 'viewer', 'mrev_system_1'));
    draft.membershipRevisions.push(revision('mrev_system_1', 'system:migration', 'viewer'));
    return [];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  assert.equal(f.store.snapshot().revision, 1);
  f.store.close();
});

test('contracts: MembershipInvite restricts roles, status, and timestamps', t => {
  const valid = invite();
  assert.doesNotThrow(() => assertMembershipInvite(valid));
  assert.throws(() => assertMembershipInvite({ ...valid, role: 'owner' }), { code: 'CONTRACT_INVALID_ENUM' });
  assert.throws(() => assertMembershipInvite({ ...valid, status: 'accepted' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertMembershipInvite({ ...valid, status: 'revoked' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.doesNotThrow(() => assertMembershipInvite({ ...valid, status: 'accepted', acceptedAt: T1 }));
  const f = baseStore(t);
  f.store[INTERNAL](1, draft => {
    draft.membershipInvites.push(valid);
    return [];
  });
  assert.equal(f.store.snapshot().membershipInvites[0].inviteId, 'inv_1');
  f.store.close();
});

test('contracts: Membership composite key and agent role rules are enforced', t => {
  const f = baseStore(t);
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.workspaceMembers.push(member('prn_agent', 'operator', 'mrev_agent_1'));
    return [];
  }), { code: 'CONTRACT_DUPLICATE_KEY' });
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.workspaceMembers[1] = member('prn_agent', 'admin', 'mrev_agent_1');
    draft.membershipRevisions[1] = revision('mrev_agent_1', 'prn_agent', 'admin');
    return [];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  assert.equal(f.store.snapshot().revision, 1);
  f.store.close();
});

test('contracts: valid Delegation commits through the Store', t => {
  const f = baseStore(t);
  f.store[INTERNAL](1, draft => {
    draft.delegations.push(delegation());
    return [];
  });
  assert.equal(f.store.snapshot().delegations.length, 1);
  assert.equal(f.store.snapshot().delegations[0].delegationId, 'dlg_1');
  f.store.close();
});

test('contracts: Delegation rejects wrong principal types and missing membership ends', t => {
  const f = baseStore(t);
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.delegations.push(delegation({ grantorPrincipalId: 'prn_agent', delegatePrincipalId: 'prn_owner' }));
    return [];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.principals.push(agent('prn_agent_2', { createdByPrincipalId: 'prn_owner' }));
    draft.delegations.push(delegation({ delegatePrincipalId: 'prn_agent_2' }));
    return [];
  }), { code: 'CONTRACT_INVALID_REFERENCE' });
  assert.equal(f.store.snapshot().revision, 1);
  f.store.close();
});

test('contracts: Workspace owner must be a user and owner membership is unique', t => {
  const f = fixture(t);
  const store = f.store();
  assert.throws(() => store[INTERNAL](0, draft => {
    draft.principals.push(user('prn_owner'), agent('prn_agent', { createdByPrincipalId: null }));
    draft.workspaces.push(workspace('ws_1', 'prn_agent'));
    draft.workspaceMembers.push(member('prn_agent', 'owner', 'mrev_owner_1'));
    draft.membershipRevisions.push(revision('mrev_owner_1', 'prn_agent', 'owner'));
    return [event()];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  assert.equal(store.snapshot().revision, 0);
  store.close();
});

test('contracts: MembershipRevision points to the current membership version', t => {
  const f = baseStore(t);
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.workspaceMembers[1] = member('prn_agent', 'operator', 'mrev_agent_1', 2);
    return [];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  assert.equal(f.store.snapshot().revision, 1);
  f.store.close();
});

test('contracts: Delegation validates both membership ends and scopes', t => {
  const valid = delegation();
  assert.doesNotThrow(() => assertDelegationGrant(valid));
  assert.doesNotThrow(() => assertDelegationGrant(delegation({ resourceScope: { kind: 'tasks', taskIds: ['tsk_1'] } })));
  assert.doesNotThrow(() => assertDelegationGrant(delegation({ resourceScope: { kind: 'artifacts', artifactIds: ['art_1'] } })));
  assert.doesNotThrow(() => assertDelegationGrant(delegation({ status: 'expired' })));
  assert.throws(() => assertDelegationGrant(delegation({ status: 'revoked' })), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertDelegationGrant({ ...valid, parentDelegationId: 'dlg_parent' }), { code: 'CONTRACT_DELEGATION_SECONDARY' });
  assert.throws(() => assertDelegationGrant({ ...valid, scopes: ['workspace:create'] }), { code: 'CONTRACT_INVALID_ENUM' });
  assert.throws(() => assertDelegationGrant({ ...valid, resourceScope: { kind: 'tasks', artifactIds: ['art_1'] } }), { code: 'CONTRACT_SCOPE_INVALID' });
  const missingDelegateMembershipVersion = delegation();
  delete missingDelegateMembershipVersion.delegateMembershipVersion;
  assert.throws(() => assertDelegationGrant(missingDelegateMembershipVersion), { code: 'CONTRACT_REQUIRED_FIELD' });

  const f = baseStore(t);
  f.store[INTERNAL](1, draft => {
    draft.delegations.push(valid);
    draft.principals[1] = agent('prn_agent', { status: 'disabled', disabledAt: T1, version: 2 });
    draft.workspaceMembers[1] = member('prn_agent', 'operator', 'mrev_agent_2', 2, 'revoked');
    draft.membershipRevisions.push(revision('mrev_agent_2', 'prn_agent', 'operator', 2, 'revoked', { previousRevisionId: 'mrev_agent_1', time: T1 }));
    return [];
  });
  assert.equal(f.store.snapshot().delegations[0].delegateMembershipVersion, 1);
  assert.throws(() => f.store[INTERNAL](2, draft => {
    draft.delegations.push(delegation({ delegationId: 'dlg_2', delegateMembershipVersion: 3 }));
    return [];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  f.store.close();
});

test('contracts: fence identity and canonical sourceKey', () => {
  assert.equal(canonicalSourceKey('principal', 'prn:odd%'), 'principal:prn%3Aodd%25');
  assert.deepEqual(parseCanonicalSourceKey('principal:prn%3Aodd%25'), { sourceKind: 'principal', principalId: 'prn:odd%', workspaceId: null, delegationId: null });
  assert.equal(canonicalSourceKey('membership', 'ws:1', 'prn:1'), 'membership:ws%3A1:prn%3A1');
  assert.equal(canonicalSourceKey('delegation', 'dlg:1'), 'delegation:dlg%3A1');
  assert.throws(() => parseCanonicalSourceKey('principal:prn:odd'), { code: 'CONTRACT_INVALID_SOURCE_KEY' });
  assert.throws(() => parseCanonicalSourceKey('principal:prn%3aodd'), { code: 'CONTRACT_INVALID_SOURCE_KEY' });
  assert.throws(() => parseCanonicalSourceKey('principal:prn odd'), { code: 'CONTRACT_INVALID_SOURCE_KEY' });
  assert.throws(() => parseCanonicalSourceKey('membership:ws_1'), { code: 'CONTRACT_INVALID_SOURCE_KEY' });

  const principalFence = fence();
  assert.doesNotThrow(() => assertAuthorityRevocationFence(principalFence));
  assert.throws(() => assertAuthorityRevocationFence({ ...principalFence, sourceKind: 'membership' }), { code: 'CONTRACT_FENCE_IDENTITY_MISMATCH' });
  assert.throws(() => assertAuthorityRevocationFence({ ...principalFence, principalId: 'prn_other' }), { code: 'CONTRACT_FENCE_IDENTITY_MISMATCH' });
  assert.throws(() => assertAuthorityRevocationFence({ ...principalFence, scope: { kind: 'workspace', workspaceId: 'ws_1' } }), { code: 'CONTRACT_FENCE_IDENTITY_MISMATCH' });
  assert.throws(() => assertAuthorityRevocationFence({ ...principalFence, cause: 'expired' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertAuthorityRevocationFence({ ...principalFence, status: 'quarantined', quarantineReason: null }), { code: 'CONTRACT_INVALID_COMBINATION' });
  const delegationFence = fence({
    sourceKind: 'delegation',
    sourceKey: canonicalSourceKey('delegation', 'dlg_1'),
    scope: { kind: 'workspace', workspaceId: 'ws_2' },
    principalId: null,
    delegationId: 'dlg_1',
    cause: 'revoked',
  });
  assert.throws(() => assertAuthorityRevocationFence(delegationFence, { delegations: [delegation()] }), { code: 'CONTRACT_FENCE_IDENTITY_MISMATCH' });
});

test('contracts: Store rejects a fence sourceVersion that does not precede the source', t => {
  const f = baseStore(t);
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.principals.push(user('prn_disabled', { status: 'disabled', disabledAt: T1, updatedAt: T1, version: 2 }));
    draft.revocationFences.push(fence({
      fenceId: 'fence_bad_version',
      sourceKey: canonicalSourceKey('principal', 'prn_disabled'),
      principalId: 'prn_disabled',
      sourceVersion: 2,
    }));
    return [];
  }), { code: 'CONTRACT_FENCE_SOURCE_VERSION' });
  assert.equal(f.store.snapshot().revision, 1);
  f.store.close();
});

test('contracts: principal, membership, and delegation fences are usable with matching authority', t => {
  const f = baseStore(t);
  f.store[INTERNAL](1, draft => {
    draft.principals.push(user('prn_disabled', { status: 'disabled', disabledAt: T1, deletedAt: null, updatedAt: T1, version: 2 }));
    draft.revocationFences.push(fence({
      fenceId: 'fence_principal',
      sourceKey: canonicalSourceKey('principal', 'prn_disabled'),
      principalId: 'prn_disabled',
      sourceVersion: 1,
    }));
    return [];
  });
  const principalFence = f.store.snapshot().revocationFences[0];
  assert.doesNotThrow(() => assertFenceUsable(principalFence, { principal: f.store.snapshot().principals[2] }));

  f.store[INTERNAL](2, draft => {
    draft.principals[1] = agent('prn_agent', { status: 'disabled', disabledAt: T1, version: 2 });
    draft.workspaceMembers[1] = member('prn_agent', 'operator', 'mrev_agent_2', 2, 'revoked');
    draft.membershipRevisions.push(revision('mrev_agent_2', 'prn_agent', 'operator', 2, 'revoked', { previousRevisionId: 'mrev_agent_1', time: T1 }));
    draft.revocationFences.push(fence({
      fenceId: 'fence_membership',
      sourceKind: 'membership',
      sourceKey: canonicalSourceKey('membership', 'ws_1', 'prn_agent'),
      scope: { kind: 'workspace', workspaceId: 'ws_1' },
      principalId: 'prn_agent',
      cause: 'revoked',
      sourceVersion: 1,
    }));
    return [];
  });
  const membershipFence = f.store.snapshot().revocationFences[1];
  assert.doesNotThrow(() => assertFenceUsable(membershipFence, { membership: f.store.snapshot().workspaceMembers[1] }));

  f.store[INTERNAL](3, draft => {
    draft.delegations.push(delegation({ delegationId: 'dlg_revoked', status: 'revoked', version: 2, revokedAt: T1, revokedBy: 'prn_owner', revokeReason: 'done' }));
    draft.revocationFences.push(fence({
      fenceId: 'fence_delegation',
      sourceKind: 'delegation',
      sourceKey: canonicalSourceKey('delegation', 'dlg_revoked'),
      scope: { kind: 'workspace', workspaceId: 'ws_1' },
      principalId: null,
      delegationId: 'dlg_revoked',
      cause: 'revoked',
      sourceVersion: 1,
    }));
    return [];
  });
  const delegationFence = f.store.snapshot().revocationFences[2];
  assert.doesNotThrow(() => assertFenceUsable(delegationFence, {
    delegation: f.store.snapshot().delegations[0],
    delegations: f.store.snapshot().delegations,
  }));
  assert.throws(() => assertFenceUsable({ ...membershipFence, sourceVersion: 2 }, { membership: f.store.snapshot().workspaceMembers[1] }), { code: 'CONTRACT_FENCE_SOURCE_VERSION' });
  f.store.close();
});

test('contracts: quarantined fence can record a mismatch only on the explicit repair path', () => {
  const bad = fence({
    fenceId: 'fence_q',
    sourceKind: 'membership',
    sourceKey: canonicalSourceKey('membership', 'ws_1', 'prn_agent'),
    scope: { kind: 'workspace', workspaceId: 'ws_1' },
    principalId: 'prn_other',
    status: 'quarantined',
    completedAt: null,
    quarantineReason: 'source identity mismatch',
    cause: 'revoked',
  });
  assert.throws(() => assertAuthorityRevocationFence(bad), { code: 'CONTRACT_FENCE_IDENTITY_MISMATCH' });
  assert.doesNotThrow(() => assertAuthorityRevocationFence(bad, { allowQuarantinedMismatch: true }));
  assert.throws(() => assertFenceUsable(bad, { allowQuarantinedMismatch: true, membership: member('prn_agent', 'operator', 'mrev_agent_1') }), { code: 'CONTRACT_FENCE_IDENTITY_MISMATCH' });
});

test('contracts: AuthorizationContext is structural only and enforces its own combos', () => {
  const userContext = {
    connectionId: 'conn_1', actorPrincipalId: 'prn_owner', actorType: 'user', workspaceId: 'ws_1',
    requestedByPrincipalId: 'prn_owner', delegationId: null, authorizationRevision: 0,
    principalVersion: 1, membershipVersion: 1, delegationVersion: null, workspacePolicyVersion: 1,
  };
  assert.doesNotThrow(() => assertAuthorizationContext(userContext));
  assert.doesNotThrow(() => assertAuthorizationContext({ ...userContext, actorPrincipalId: 'prn_agent', actorType: 'agent', requestedByPrincipalId: 'prn_owner', delegationId: 'dlg_1', delegationVersion: 1, membershipVersion: 1 }));
  assert.doesNotThrow(() => assertAuthorizationContext({ ...userContext, workspaceId: null, membershipVersion: null }));
  assert.throws(() => assertAuthorizationContext({ ...userContext, requestedByPrincipalId: 'prn_other' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertAuthorizationContext({ ...userContext, actorType: 'system', delegationId: 'dlg_1', delegationVersion: 1 }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertAuthorizationContext({ ...userContext, delegationVersion: 1 }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertAuthorizationContext({ ...userContext, managementScope: 'admin' }), { code: 'CONTRACT_INVALID_ENUM' });
});

test('contracts: DomainEvent scope, sequence fields, and 4 KiB limit', () => {
  const e = { eventId: 'evt_1', sequence: 1, revision: 1, time: T0, ...event() };
  assert.doesNotThrow(() => assertDomainEvent(e));
  assert.throws(() => assertDomainEvent({ ...e, scope: 'workspace' }), { code: 'CONTRACT_INVALID_FIELD' });
  assert.throws(() => assertDomainEvent({ ...e, workspaceId: 'ws_1' }), { code: 'CONTRACT_INVALID_COMBINATION' });
  assert.throws(() => assertDomainEvent({ ...e, sequence: 0 }), { code: 'CONTRACT_INVALID_VERSION' });
  assert.throws(() => assertDomainEvent({ ...e, data: { text: 'x'.repeat(5000) } }), { code: 'CONTRACT_INVALID_FIELD' });
});

test('contracts: RequestRecord scope hash, result bytes, and references', () => {
  const r = request();
  assert.doesNotThrow(() => assertRequestRecord(r));
  assert.throws(() => assertRequestRecord({ ...r, scopeHash: 'a'.repeat(64) }), { code: 'CONTRACT_INVALID_FIELD' });
  assert.throws(() => assertRequestRecord({ ...r, resultBytes: 1 }), { code: 'CONTRACT_INVALID_FIELD' });
  assert.throws(() => assertRequestRecord({ ...r, inputHash: 'short' }), { code: 'CONTRACT_INVALID_FIELD' });
});

test('contracts: BootstrapState and Store bootstrap cross-reference', t => {
  const b = { bootstrapPrincipalId: 'prn_owner', workspaceId: 'ws_1', ownerPrincipalId: 'prn_owner', rootFingerprint: 'fingerprint', completedAt: T1 };
  assert.doesNotThrow(() => assertBootstrapState(b));
  const f = baseStore(t);
  f.store[INTERNAL](1, draft => {
    draft.bootstrapState = b;
    return [];
  });
  assert.deepEqual(f.store.snapshot().bootstrapState, b);
  assert.throws(() => f.store[INTERNAL](2, draft => {
    draft.bootstrapState = { ...b, ownerPrincipalId: 'prn_agent' };
    return [];
  }), { code: 'CONTRACT_STATE_INCONSISTENT' });
  f.store.close();
});

test('contracts: valid RequestRecord and DomainEvent coexist with a task result ref', t => {
  const f = baseStore(t);
  const task = { taskId: 'tsk_1' };
  const r = request();
  f.store[INTERNAL](1, draft => {
    draft.tasks.push(task);
    draft.requests.push(r);
    return [];
  });
  assert.equal(f.store.snapshot().requests.length, 1);
  assert.equal(f.store.snapshot().tasks[0].taskId, 'tsk_1');
  f.store.close();
});

test('contracts: invalid entity commit is rejected with CONTRACT_* and does not mutate state', t => {
  const f = baseStore(t);
  const before = f.store.snapshot();
  assert.throws(() => f.store[INTERNAL](1, draft => {
    draft.principals[0].status = 'root';
    return [];
  }), { code: 'CONTRACT_INVALID_ENUM' });
  assert.deepEqual(f.store.snapshot(), before);
  f.store.close();
});

test('contracts: invalid persisted entity fails closed as STORE_CORRUPT and preserves bytes', t => {
  const f = baseStore(t);
  f.store.close();
  const state = JSON.parse(readFileSync(f.stateFile, 'utf8'));
  state.principals[0].status = 'root';
  writeFileSync(f.stateFile, JSON.stringify(state) + '\n');
  assert.throws(() => f.makeStore(), error => error.code === 'STORE_CORRUPT' && error.contractCode === 'CONTRACT_INVALID_ENUM');
});

test('contracts: valid snapshot is not rewritten by opening it', t => {
  const f = baseStore(t);
  f.store.close();
  const before = readFileSync(f.stateFile, 'utf8');
  const reopened = f.makeStore();
  assert.equal(readFileSync(f.stateFile, 'utf8'), before);
  reopened.close();
});
