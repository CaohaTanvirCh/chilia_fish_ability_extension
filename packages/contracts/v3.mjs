import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

/**
 * Phase 2.1A Contracts v3 runtime validators.
 *
 * These validators are structural and local. They do not authenticate anyone,
 * and `AuthorizationContext` is not trusted merely because it validates.
 * The future Store `commitAuthorized` path remains responsible for deriving a
 * trusted context and performing final authorization.
 */

export const V3_SCHEMA_VERSION = 3;

export const CONTRACT_ERROR_CODES = Object.freeze({
  REQUIRED: 'CONTRACT_REQUIRED_FIELD',
  FIELD: 'CONTRACT_INVALID_FIELD',
  ENUM: 'CONTRACT_INVALID_ENUM',
  ID: 'CONTRACT_INVALID_ID',
  TIME: 'CONTRACT_INVALID_TIME',
  VERSION: 'CONTRACT_INVALID_VERSION',
  UNKNOWN: 'CONTRACT_UNKNOWN_FIELD',
  COMBINATION: 'CONTRACT_INVALID_COMBINATION',
  DUPLICATE: 'CONTRACT_DUPLICATE_KEY',
  REFERENCE: 'CONTRACT_INVALID_REFERENCE',
  SOURCE_KEY: 'CONTRACT_INVALID_SOURCE_KEY',
  FENCE_IDENTITY: 'CONTRACT_FENCE_IDENTITY_MISMATCH',
  FENCE_VERSION: 'CONTRACT_FENCE_SOURCE_VERSION',
  SECONDARY_DELEGATION: 'CONTRACT_DELEGATION_SECONDARY',
  SCOPE: 'CONTRACT_SCOPE_INVALID',
  STATE: 'CONTRACT_STATE_INCONSISTENT',
});

const CODES = CONTRACT_ERROR_CODES;
const PRINCIPAL_TYPES = new Set(['user', 'agent', 'system']);
const PRINCIPAL_STATUSES = new Set(['active', 'disabled']);
const CONNECTOR_KINDS = new Set(['local', 'remote', 'system']);
const WORKSPACE_STATUSES = new Set(['active', 'archived', 'deleted']);
const ROOT_STATUSES = new Set(['bound', 'unbound']);
const BOUNDARY_ENFORCEMENTS = new Set(['cooperative', 'os-enforced']);
const QUARANTINE_STATES = new Set(['normal', 'quarantined']);
const ISOLATION_POLICIES = new Set(['mutex', 'git-worktree', 'directory-copy']);
const GOVERNANCE_STATES = new Set(['normal', 'ownerless_locked']);
const MEMBER_ROLES = new Set(['owner', 'admin', 'operator', 'viewer']);
const MEMBER_STATUSES = new Set(['active', 'revoked']);
const EFFECTIVE_MEMBER_STATUSES = new Set(['active', 'suspended', 'revoked']);
const INVITE_ROLES = new Set(['admin', 'operator', 'viewer']);
const INVITE_STATUSES = new Set(['pending', 'accepted', 'revoked', 'expired']);
const DELEGATION_STATUSES = new Set(['active', 'revoked', 'expired']);
const DELEGATION_SCOPES = new Set([
  'task:read', 'task:create', 'task:control',
  'execution:read', 'execution:create', 'execution:control',
  'artifact:read', 'artifact:write',
]);
const RESOURCE_SCOPE_KINDS = new Set(['workspace', 'tasks', 'artifacts']);
const FENCE_SOURCE_KINDS = new Set(['principal', 'membership', 'delegation']);
const FENCE_SCOPE_KINDS = new Set(['global', 'workspace']);
const FENCE_CAUSES = new Set(['disabled', 'deleted', 'revoked', 'expired']);
const FENCE_STATUSES = new Set(['pending', 'reconciling', 'completed', 'failed', 'quarantined']);
const EVENT_SCOPES = new Set(['workspace', 'system']);
const EVENT_SOURCES = new Set(['user', 'agent', 'hub', 'executor', 'system']);
const EVENT_AUDIENCES = new Set(['tenant', 'admin', 'system']);
const ACTOR_TYPES = new Set(['user', 'agent', 'system']);
const MANAGEMENT_SCOPES = new Set(['multi_workspace']);
const REQUEST_STATUSES = new Set(['committed']);
const HASH_RE = /^[a-f0-9]{64}$/;
const EVENT_MAX_BYTES = 4096;
const RESULT_MAX_BYTES = 64 * 1024;
const UNRESERVED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~');

export class ContractsV3Error extends Error {
  constructor(code, path, message, details) {
    super(`${path}: ${message}`);
    this.name = 'ContractsV3Error';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function fail(code, path, message, details) {
  throw new ContractsV3Error(code, path, message, details);
}
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    fail(CODES.FIELD, 'value', 'Expected finite acyclic JSON');
  }
  ancestors.add(value);
  for (const item of Object.values(value)) jsonValue(item, ancestors);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail(CODES.FIELD, 'value', 'Sparse JSON array');
  ancestors.delete(value);
}
function assertRecord(value, path) {
  if (!isRecord(value)) fail(CODES.FIELD, path, 'Expected a record');
  try {
    jsonValue(value);
  } catch (error) {
    if (error instanceof ContractsV3Error) fail(CODES.FIELD, path, `Invalid JSON record: ${error.message}`);
    throw error;
  }
}
function assertFields(value, path, allowed, required) {
  assertRecord(value, path);
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(CODES.UNKNOWN, `${path}.${key}`, 'Unknown field');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(CODES.REQUIRED, `${path}.${key}`, 'Required field is missing');
}
function str(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(CODES.FIELD, path, 'Expected a nonempty string');
}
function nullableStr(value, path, { allowEmpty = false } = {}) {
  if (value === null) return;
  str(value, path, { allowEmpty });
}
function id(value, path) {
  str(value, path);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(CODES.ID, path, 'ID must not contain control characters');
}
function nullableId(value, path) {
  if (value === null) return;
  id(value, path);
}
function timestamp(value, path) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(CODES.TIME, path, 'Expected an ISO timestamp');
}
function nullableTimestamp(value, path) {
  if (value === null) return;
  timestamp(value, path);
}
function nonNegative(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(CODES.VERSION, path, 'Expected a nonnegative safe integer');
}
function version(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(CODES.VERSION, path, 'Expected a positive safe integer version');
}
function enumeration(value, allowed, path) {
  if (!allowed.has(value)) fail(CODES.ENUM, path, `Unsupported value: ${String(value)}`);
}
function stringArray(value, path, { min = 0, max = Infinity, unique = true } = {}) {
  if (!Array.isArray(value)) fail(CODES.FIELD, path, 'Expected an array');
  if (value.length < min || value.length > max) fail(CODES.FIELD, path, `Array length must be between ${min} and ${max}`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    str(item, `${path}[${index}]`);
    if (unique && seen.has(item)) fail(CODES.DUPLICATE, `${path}[${index}]`, 'Duplicate value');
    seen.add(item);
  }
}
function idArray(value, path, options) {
  stringArray(value, path, options);
  for (const [index, item] of value.entries()) id(item, `${path}[${index}]`);
}
function same(actual, expected, path, message) {
  if (actual !== expected) fail(CODES.COMBINATION, path, message);
}
function timeOrder(first, second, firstPath, secondPath) {
  if (Date.parse(first) > Date.parse(second)) fail(CODES.COMBINATION, firstPath, `${firstPath} must not be after ${secondPath}`);
}
function assertJson(value, path) {
  try {
    jsonValue(value);
  } catch (error) {
    if (error instanceof ContractsV3Error) fail(CODES.FIELD, path, `Invalid JSON value: ${error.message}`);
    throw error;
  }
}
function assertByteLimit(value, path, max) {
  if (Buffer.byteLength(JSON.stringify(value)) > max) fail(CODES.FIELD, path, `Value exceeds ${max} bytes`);
}

function assertAgentProfile(value, path) {
  assertFields(value, path, ['registeredByPrincipalId', 'connectorKind', 'capabilities'], ['registeredByPrincipalId', 'connectorKind', 'capabilities']);
  id(value.registeredByPrincipalId, `${path}.registeredByPrincipalId`);
  enumeration(value.connectorKind, CONNECTOR_KINDS, `${path}.connectorKind`);
  stringArray(value.capabilities, `${path}.capabilities`, { unique: true });
}

export function assertPrincipal(value, options = {}) {
  const path = options.path ?? 'principal';
  assertFields(value, path,
    ['principalId', 'principalType', 'displayName', 'status', 'deletedAt', 'disabledAt', 'disabledReason', 'createdByPrincipalId', 'createdAt', 'updatedAt', 'version', 'agentProfile'],
    ['principalId', 'principalType', 'displayName', 'status', 'deletedAt', 'disabledAt', 'disabledReason', 'createdByPrincipalId', 'createdAt', 'updatedAt', 'version']);
  id(value.principalId, `${path}.principalId`);
  enumeration(value.principalType, PRINCIPAL_TYPES, `${path}.principalType`);
  nullableStr(value.displayName, `${path}.displayName`, { allowEmpty: true });
  enumeration(value.status, PRINCIPAL_STATUSES, `${path}.status`);
  nullableTimestamp(value.deletedAt, `${path}.deletedAt`);
  nullableTimestamp(value.disabledAt, `${path}.disabledAt`);
  nullableStr(value.disabledReason, `${path}.disabledReason`, { allowEmpty: true });
  nullableId(value.createdByPrincipalId, `${path}.createdByPrincipalId`);
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  version(value.version, `${path}.version`);
  timeOrder(value.createdAt, value.updatedAt, `${path}.createdAt`, `${path}.updatedAt`);

  if (value.deletedAt !== null && value.status !== 'disabled') fail(CODES.COMBINATION, `${path}.deletedAt`, 'deletedAt requires status=disabled');
  if (value.status === 'disabled' && value.deletedAt === null && value.disabledAt === null) fail(CODES.COMBINATION, `${path}.disabledAt`, 'Disabled principal requires disabledAt');
  if (value.principalType === 'system') {
    if (!value.principalId.startsWith('system:')) fail(CODES.ID, `${path}.principalId`, 'System principal ID must use the reserved system: prefix');
    if (Object.hasOwn(value, 'agentProfile')) fail(CODES.COMBINATION, `${path}.agentProfile`, 'System principal cannot have agentProfile');
  } else {
    if (value.principalId.startsWith('system:')) fail(CODES.ID, `${path}.principalId`, 'system: prefix is reserved for system principals');
    if (value.principalType === 'agent') {
      if (Object.hasOwn(value, 'agentProfile')) assertAgentProfile(value.agentProfile, `${path}.agentProfile`);
    } else if (Object.hasOwn(value, 'agentProfile')) {
      fail(CODES.COMBINATION, `${path}.agentProfile`, 'agentProfile is only valid for agent principals');
    }
  }
  return value;
}

function assertRootIdentity(value, path) {
  assertFields(value, path, ['volumeSerial', 'fileId', 'finalPath', 'observedAt'], ['volumeSerial', 'fileId', 'finalPath', 'observedAt']);
  str(value.volumeSerial, `${path}.volumeSerial`);
  str(value.fileId, `${path}.fileId`);
  str(value.finalPath, `${path}.finalPath`);
  timestamp(value.observedAt, `${path}.observedAt`);
}

export function assertWorkspace(value, options = {}) {
  const path = options.path ?? 'workspace';
  assertFields(value, path,
    ['workspaceId', 'name', 'status', 'ownerPrincipalId', 'rootStatus', 'rootRef', 'rootPath', 'rootIdentity', 'workspaceBoundaryEnforcement', 'quarantineState', 'quarantineReason', 'quarantinedAt', 'isolationPolicy', 'governanceState', 'writeEpoch', 'policyVersion', 'createdByPrincipalId', 'createdAt', 'updatedAt', 'archivedAt', 'deletedAt', 'deletedFrom'],
    ['workspaceId', 'name', 'status', 'ownerPrincipalId', 'rootStatus', 'rootRef', 'rootPath', 'rootIdentity', 'workspaceBoundaryEnforcement', 'quarantineState', 'quarantineReason', 'quarantinedAt', 'isolationPolicy', 'governanceState', 'writeEpoch', 'policyVersion', 'createdByPrincipalId', 'createdAt', 'updatedAt', 'archivedAt', 'deletedAt', 'deletedFrom']);
  id(value.workspaceId, `${path}.workspaceId`);
  str(value.name, `${path}.name`);
  enumeration(value.status, WORKSPACE_STATUSES, `${path}.status`);
  id(value.ownerPrincipalId, `${path}.ownerPrincipalId`);
  enumeration(value.rootStatus, ROOT_STATUSES, `${path}.rootStatus`);
  nullableStr(value.rootRef, `${path}.rootRef`);
  nullableStr(value.rootPath, `${path}.rootPath`);
  if (value.rootIdentity !== null) assertRootIdentity(value.rootIdentity, `${path}.rootIdentity`);
  enumeration(value.workspaceBoundaryEnforcement, BOUNDARY_ENFORCEMENTS, `${path}.workspaceBoundaryEnforcement`);
  enumeration(value.quarantineState, QUARANTINE_STATES, `${path}.quarantineState`);
  nullableStr(value.quarantineReason, `${path}.quarantineReason`, { allowEmpty: true });
  nullableTimestamp(value.quarantinedAt, `${path}.quarantinedAt`);
  enumeration(value.isolationPolicy, ISOLATION_POLICIES, `${path}.isolationPolicy`);
  enumeration(value.governanceState, GOVERNANCE_STATES, `${path}.governanceState`);
  nonNegative(value.writeEpoch, `${path}.writeEpoch`);
  nonNegative(value.policyVersion, `${path}.policyVersion`);
  id(value.createdByPrincipalId, `${path}.createdByPrincipalId`);
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  nullableTimestamp(value.archivedAt, `${path}.archivedAt`);
  nullableTimestamp(value.deletedAt, `${path}.deletedAt`);
  if (value.deletedFrom !== null && !['live', 'archived'].includes(value.deletedFrom)) fail(CODES.ENUM, `${path}.deletedFrom`, 'Unsupported deletedFrom');
  timeOrder(value.createdAt, value.updatedAt, `${path}.createdAt`, `${path}.updatedAt`);

  if (value.rootStatus === 'bound') {
    if (value.rootIdentity === null) fail(CODES.COMBINATION, `${path}.rootIdentity`, 'Bound root requires rootIdentity');
    if (value.rootRef === null) fail(CODES.COMBINATION, `${path}.rootRef`, 'Bound root requires rootRef');
  } else {
    if (value.rootIdentity !== null || value.rootRef !== null || value.rootPath !== null) fail(CODES.COMBINATION, `${path}.rootStatus`, 'Unbound root must have null rootRef/rootPath/rootIdentity');
  }
  if (value.quarantineState === 'normal') {
    if (value.quarantineReason !== null || value.quarantinedAt !== null) fail(CODES.COMBINATION, `${path}.quarantineState`, 'Normal workspace must not carry quarantine fields');
  } else {
    if (!value.quarantineReason || value.quarantinedAt === null) fail(CODES.COMBINATION, `${path}.quarantineState`, 'Quarantined workspace requires reason and time');
  }
  if (value.status === 'active') {
    if (value.archivedAt !== null || value.deletedAt !== null || value.deletedFrom !== null) fail(CODES.COMBINATION, `${path}.status`, 'Active workspace cannot carry archive/delete fields');
  } else if (value.status === 'archived') {
    if (value.archivedAt === null || value.deletedAt !== null || value.deletedFrom !== null) fail(CODES.COMBINATION, `${path}.status`, 'Archived workspace requires archivedAt and no delete fields');
  } else {
    if (value.deletedAt === null || value.deletedFrom === null) fail(CODES.COMBINATION, `${path}.status`, 'Deleted workspace requires deletedAt and deletedFrom');
  }
  return value;
}

const MEMBER_FIELDS = ['workspaceId', 'principalId', 'role', 'status', 'version', 'lastMembershipRevisionId', 'grantedByPrincipalId', 'grantedAt', 'updatedAt', 'revokedAt', 'revokedReason'];

export function assertWorkspaceMember(value, options = {}) {
  const path = options.path ?? 'workspaceMember';
  assertFields(value, path, MEMBER_FIELDS, MEMBER_FIELDS);
  id(value.workspaceId, `${path}.workspaceId`);
  id(value.principalId, `${path}.principalId`);
  enumeration(value.role, MEMBER_ROLES, `${path}.role`);
  enumeration(value.status, MEMBER_STATUSES, `${path}.status`);
  version(value.version, `${path}.version`);
  id(value.lastMembershipRevisionId, `${path}.lastMembershipRevisionId`);
  id(value.grantedByPrincipalId, `${path}.grantedByPrincipalId`);
  timestamp(value.grantedAt, `${path}.grantedAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  nullableTimestamp(value.revokedAt, `${path}.revokedAt`);
  nullableStr(value.revokedReason, `${path}.revokedReason`, { allowEmpty: true });
  timeOrder(value.grantedAt, value.updatedAt, `${path}.grantedAt`, `${path}.updatedAt`);
  if (value.status === 'active' && value.revokedAt !== null) fail(CODES.COMBINATION, `${path}.revokedAt`, 'Active membership cannot have revokedAt');
  if (value.status === 'revoked' && value.revokedAt === null) fail(CODES.COMBINATION, `${path}.revokedAt`, 'Revoked membership requires revokedAt');
  if (Object.hasOwn(value, 'effectiveStatus')) fail(CODES.UNKNOWN, `${path}.effectiveStatus`, 'effectiveStatus is a projection, not stored authority');
  return value;
}

export function assertMembershipRevision(value, options = {}) {
  const path = options.path ?? 'membershipRevision';
  assertFields(value, path,
    ['membershipRevisionId', 'workspaceId', 'principalId', 'version', 'storedStatus', 'role', 'actorPrincipalId', 'time', 'reason', 'previousRevisionId'],
    ['membershipRevisionId', 'workspaceId', 'principalId', 'version', 'storedStatus', 'role', 'actorPrincipalId', 'time', 'reason', 'previousRevisionId']);
  id(value.membershipRevisionId, `${path}.membershipRevisionId`);
  id(value.workspaceId, `${path}.workspaceId`);
  id(value.principalId, `${path}.principalId`);
  version(value.version, `${path}.version`);
  enumeration(value.storedStatus, MEMBER_STATUSES, `${path}.storedStatus`);
  enumeration(value.role, MEMBER_ROLES, `${path}.role`);
  id(value.actorPrincipalId, `${path}.actorPrincipalId`);
  timestamp(value.time, `${path}.time`);
  nullableStr(value.reason, `${path}.reason`, { allowEmpty: true });
  nullableId(value.previousRevisionId, `${path}.previousRevisionId`);
  return value;
}

export function assertMembershipInvite(value, options = {}) {
  const path = options.path ?? 'membershipInvite';
  assertFields(value, path,
    ['inviteId', 'workspaceId', 'targetPrincipalId', 'role', 'tokenHash', 'status', 'createdByPrincipalId', 'createdAt', 'expiresAt', 'acceptedAt', 'revokedAt'],
    ['inviteId', 'workspaceId', 'targetPrincipalId', 'role', 'tokenHash', 'status', 'createdByPrincipalId', 'createdAt', 'expiresAt', 'acceptedAt', 'revokedAt']);
  id(value.inviteId, `${path}.inviteId`);
  id(value.workspaceId, `${path}.workspaceId`);
  id(value.targetPrincipalId, `${path}.targetPrincipalId`);
  enumeration(value.role, INVITE_ROLES, `${path}.role`);
  str(value.tokenHash, `${path}.tokenHash`);
  enumeration(value.status, INVITE_STATUSES, `${path}.status`);
  id(value.createdByPrincipalId, `${path}.createdByPrincipalId`);
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.expiresAt, `${path}.expiresAt`);
  nullableTimestamp(value.acceptedAt, `${path}.acceptedAt`);
  nullableTimestamp(value.revokedAt, `${path}.revokedAt`);
  timeOrder(value.createdAt, value.expiresAt, `${path}.createdAt`, `${path}.expiresAt`);
  if (value.status === 'pending' && (value.acceptedAt !== null || value.revokedAt !== null)) fail(CODES.COMBINATION, `${path}.status`, 'Pending invite cannot be accepted/revoked');
  if (value.status === 'accepted' && (value.acceptedAt === null || value.revokedAt !== null)) fail(CODES.COMBINATION, `${path}.status`, 'Accepted invite requires acceptedAt and no revokedAt');
  if (value.status === 'revoked' && value.revokedAt === null) fail(CODES.COMBINATION, `${path}.status`, 'Revoked invite requires revokedAt');
  return value;
}

function assertResourceScope(value, path) {
  assertFields(value, path, ['kind', 'taskIds', 'artifactIds'], ['kind']);
  enumeration(value.kind, RESOURCE_SCOPE_KINDS, `${path}.kind`);
  if (Object.hasOwn(value, 'taskIds')) idArray(value.taskIds, `${path}.taskIds`, { unique: true });
  if (Object.hasOwn(value, 'artifactIds')) idArray(value.artifactIds, `${path}.artifactIds`, { unique: true });
  const tasks = value.taskIds ?? [];
  const artifacts = value.artifactIds ?? [];
  if (value.kind === 'workspace') {
    if (tasks.length || artifacts.length) fail(CODES.SCOPE, path, 'workspace resourceScope cannot carry explicit IDs');
  } else if (value.kind === 'tasks') {
    if (!tasks.length || artifacts.length) fail(CODES.SCOPE, path, 'tasks resourceScope requires taskIds only');
  } else {
    if (!artifacts.length || tasks.length) fail(CODES.SCOPE, path, 'artifacts resourceScope requires artifactIds only');
  }
}

export function assertDelegationGrant(value, options = {}) {
  const path = options.path ?? 'delegation';
  assertFields(value, path,
    ['delegationId', 'workspaceId', 'grantorPrincipalId', 'delegatePrincipalId', 'scopes', 'resourceScope', 'status', 'version', 'grantorPrincipalVersion', 'grantorMembershipVersion', 'delegatePrincipalVersion', 'delegateMembershipVersion', 'parentDelegationId', 'createdAt', 'expiresAt', 'revokedAt', 'revokedBy', 'revokeReason'],
    ['delegationId', 'workspaceId', 'grantorPrincipalId', 'delegatePrincipalId', 'scopes', 'resourceScope', 'status', 'version', 'grantorPrincipalVersion', 'grantorMembershipVersion', 'delegatePrincipalVersion', 'delegateMembershipVersion', 'parentDelegationId', 'createdAt', 'expiresAt', 'revokedAt', 'revokedBy', 'revokeReason']);
  id(value.delegationId, `${path}.delegationId`);
  id(value.workspaceId, `${path}.workspaceId`);
  id(value.grantorPrincipalId, `${path}.grantorPrincipalId`);
  id(value.delegatePrincipalId, `${path}.delegatePrincipalId`);
  stringArray(value.scopes, `${path}.scopes`, { min: 1, unique: true });
  for (const [index, scope] of value.scopes.entries()) if (!DELEGATION_SCOPES.has(scope)) fail(CODES.ENUM, `${path}.scopes[${index}]`, 'Unsupported delegation scope');
  assertResourceScope(value.resourceScope, `${path}.resourceScope`);
  enumeration(value.status, DELEGATION_STATUSES, `${path}.status`);
  version(value.version, `${path}.version`);
  version(value.grantorPrincipalVersion, `${path}.grantorPrincipalVersion`);
  version(value.grantorMembershipVersion, `${path}.grantorMembershipVersion`);
  version(value.delegatePrincipalVersion, `${path}.delegatePrincipalVersion`);
  version(value.delegateMembershipVersion, `${path}.delegateMembershipVersion`);
  if (value.parentDelegationId !== null) fail(CODES.SECONDARY_DELEGATION, `${path}.parentDelegationId`, 'Secondary delegation is forbidden in v3');
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.expiresAt, `${path}.expiresAt`);
  nullableTimestamp(value.revokedAt, `${path}.revokedAt`);
  nullableId(value.revokedBy, `${path}.revokedBy`);
  nullableStr(value.revokeReason, `${path}.revokeReason`, { allowEmpty: true });
  timeOrder(value.createdAt, value.expiresAt, `${path}.createdAt`, `${path}.expiresAt`);
  if (value.status === 'active' && (value.revokedAt !== null || value.revokedBy !== null || value.revokeReason !== null)) fail(CODES.COMBINATION, `${path}.status`, 'Active delegation cannot carry revocation fields');
  if (value.status === 'revoked' && (value.revokedAt === null || value.revokedBy === null)) fail(CODES.COMBINATION, `${path}.status`, 'Revoked delegation requires revokedAt and revokedBy');
  return value;
}

function decodeSourceSegment(segment, path) {
  if (!segment) fail(CODES.SOURCE_KEY, path, 'Empty sourceKey segment');
  const bytes = [];
  for (let index = 0; index < segment.length;) {
    if (segment[index] === '%') {
      const hex = segment.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) fail(CODES.SOURCE_KEY, path, 'Percent escapes must be uppercase two-digit hex');
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    } else {
      const char = segment[index];
      if (!UNRESERVED.has(char)) fail(CODES.SOURCE_KEY, path, 'Only unreserved characters and uppercase percent escapes are allowed');
      bytes.push(...Buffer.from(char, 'utf8'));
      index += 1;
    }
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
  } catch {
    fail(CODES.SOURCE_KEY, path, 'Invalid UTF-8 in sourceKey');
  }
  if (encodeSourceComponent(decoded) !== segment) fail(CODES.SOURCE_KEY, path, 'sourceKey is not canonical');
  return decoded;
}

function encodeSourceComponent(value) {
  if (typeof value !== 'string' || !value) fail(CODES.SOURCE_KEY, 'sourceKey', 'sourceKey component must be a nonempty string');
  let result = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = byte < 128 ? String.fromCharCode(byte) : null;
    if (char && UNRESERVED.has(char)) result += char;
    else result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return result;
}

export function canonicalSourceKey(sourceKind, first, second = undefined) {
  if (sourceKind === 'principal' || sourceKind === 'delegation') {
    if (second !== undefined) fail(CODES.SOURCE_KEY, 'sourceKey', `${sourceKind} sourceKey takes one ID`);
    return `${sourceKind}:${encodeSourceComponent(first)}`;
  }
  if (sourceKind === 'membership') {
    if (second === undefined) fail(CODES.SOURCE_KEY, 'sourceKey', 'membership sourceKey takes workspaceId and principalId');
    return `membership:${encodeSourceComponent(first)}:${encodeSourceComponent(second)}`;
  }
  fail(CODES.SOURCE_KEY, 'sourceKey', 'Unsupported sourceKind');
}

export function parseCanonicalSourceKey(sourceKey, path = 'sourceKey') {
  if (typeof sourceKey !== 'string') fail(CODES.SOURCE_KEY, path, 'sourceKey must be a string');
  const parts = sourceKey.split(':');
  if (parts[0] === 'principal' || parts[0] === 'delegation') {
    if (parts.length !== 2) fail(CODES.SOURCE_KEY, path, `${parts[0]} sourceKey must have two segments`);
    const decoded = decodeSourceSegment(parts[1], path);
    return parts[0] === 'principal'
      ? { sourceKind: 'principal', principalId: decoded, workspaceId: null, delegationId: null }
      : { sourceKind: 'delegation', principalId: null, workspaceId: null, delegationId: decoded };
  }
  if (parts[0] === 'membership') {
    if (parts.length !== 3) fail(CODES.SOURCE_KEY, path, 'membership sourceKey must have three segments');
    const workspaceId = decodeSourceSegment(parts[1], path);
    const principalId = decodeSourceSegment(parts[2], path);
    return { sourceKind: 'membership', principalId, workspaceId, delegationId: null };
  }
  fail(CODES.SOURCE_KEY, path, 'Unsupported sourceKey prefix');
}

function assertScope(value, path) {
  assertFields(value, path, ['kind', 'workspaceId'], ['kind', 'workspaceId']);
  enumeration(value.kind, FENCE_SCOPE_KINDS, `${path}.kind`);
  if (value.kind === 'global') {
    if (value.workspaceId !== null) fail(CODES.COMBINATION, `${path}.workspaceId`, 'Global scope requires workspaceId=null');
  } else {
    id(value.workspaceId, `${path}.workspaceId`);
  }
}

function findDelegation(options, delegationId) {
  if (!options.delegations) return null;
  const list = Array.isArray(options.delegations) ? options.delegations : Object.values(options.delegations);
  return list.find(item => item?.delegationId === delegationId) ?? null;
}

export function assertAuthorityRevocationFence(value, options = {}) {
  const path = options.path ?? 'authorityRevocationFence';
  assertFields(value, path,
    ['fenceId', 'sourceKind', 'sourceKey', 'sourceVersion', 'scope', 'principalId', 'delegationId', 'cause', 'effectiveAt', 'authorizationRevision', 'status', 'processedTaskIds', 'processedGrantIds', 'lastError', 'quarantineReason', 'diagnostics', 'createdAt', 'completedAt'],
    ['fenceId', 'sourceKind', 'sourceKey', 'sourceVersion', 'scope', 'principalId', 'delegationId', 'cause', 'effectiveAt', 'authorizationRevision', 'status', 'processedTaskIds', 'processedGrantIds', 'lastError', 'quarantineReason', 'diagnostics', 'createdAt', 'completedAt']);
  id(value.fenceId, `${path}.fenceId`);
  enumeration(value.sourceKind, FENCE_SOURCE_KINDS, `${path}.sourceKind`);
  str(value.sourceKey, `${path}.sourceKey`);
  const parsed = parseCanonicalSourceKey(value.sourceKey, `${path}.sourceKey`);
  if (parsed.sourceKind !== value.sourceKind) fail(CODES.FENCE_IDENTITY, `${path}.sourceKey`, 'sourceKey prefix does not match sourceKind');
  version(value.sourceVersion, `${path}.sourceVersion`);
  assertScope(value.scope, `${path}.scope`);
  nullableId(value.principalId, `${path}.principalId`);
  nullableId(value.delegationId, `${path}.delegationId`);
  enumeration(value.cause, FENCE_CAUSES, `${path}.cause`);
  timestamp(value.effectiveAt, `${path}.effectiveAt`);
  nonNegative(value.authorizationRevision, `${path}.authorizationRevision`);
  enumeration(value.status, FENCE_STATUSES, `${path}.status`);
  idArray(value.processedTaskIds, `${path}.processedTaskIds`, { unique: true });
  idArray(value.processedGrantIds, `${path}.processedGrantIds`, { unique: true });
  nullableStr(value.lastError, `${path}.lastError`, { allowEmpty: true });
  nullableStr(value.quarantineReason, `${path}.quarantineReason`, { allowEmpty: true });
  stringArray(value.diagnostics, `${path}.diagnostics`, { max: 32, unique: false });
  for (const [index, diagnostic] of value.diagnostics.entries()) if (Buffer.byteLength(diagnostic) > 1024) fail(CODES.FIELD, `${path}.diagnostics[${index}]`, 'Diagnostic exceeds 1 KiB');
  timestamp(value.createdAt, `${path}.createdAt`);
  nullableTimestamp(value.completedAt, `${path}.completedAt`);
  if (value.status === 'completed') {
    if (value.completedAt === null) fail(CODES.COMBINATION, `${path}.completedAt`, 'Completed fence requires completedAt');
    if (value.quarantineReason !== null) fail(CODES.COMBINATION, `${path}.quarantineReason`, 'Completed fence cannot be quarantined');
  } else if (value.completedAt !== null) {
    fail(CODES.COMBINATION, `${path}.completedAt`, 'Non-completed fence cannot have completedAt');
  }
  if (value.status === 'quarantined' && !value.quarantineReason) fail(CODES.COMBINATION, `${path}.quarantineReason`, 'Quarantined fence requires a reason');
  if (value.status !== 'quarantined' && value.quarantineReason !== null) fail(CODES.COMBINATION, `${path}.quarantineReason`, 'Only quarantined fence can have a reason');

  let consistent = true;
  if (parsed.sourceKind === 'principal') {
    consistent = value.principalId === parsed.principalId
      && value.delegationId === null
      && value.scope.kind === 'global'
      && value.scope.workspaceId === null;
  } else if (parsed.sourceKind === 'membership') {
    consistent = value.principalId === parsed.principalId
      && value.delegationId === null
      && value.scope.kind === 'workspace'
      && value.scope.workspaceId === parsed.workspaceId;
  } else {
    const delegation = findDelegation(options, parsed.delegationId);
    consistent = value.principalId === null
      && value.delegationId === parsed.delegationId
      && value.scope.kind === 'workspace'
      && (!delegation || value.scope.workspaceId === delegation.workspaceId);
    // Authority-aware callers (the Store) provide delegations; a structural
    // validator alone cannot prove the workspace. Store cross-validation uses
    // assertFenceUsable and rejects missing/mismatched authority.
  }
  if (!consistent && !(value.status === 'quarantined' && options.allowQuarantinedMismatch)) {
    fail(CODES.FENCE_IDENTITY, path, 'sourceKind/sourceKey/scope/identity fields are inconsistent');
  }
  if (consistent) {
    const expectedCause = value.sourceKind === 'principal'
      ? new Set(['disabled', 'deleted'])
      : value.sourceKind === 'membership'
        ? new Set(['revoked'])
        : new Set(['revoked', 'expired']);
    if (!expectedCause.has(value.cause)) fail(CODES.COMBINATION, `${path}.cause`, 'cause does not match sourceKind');
  }
  return value;
}

export function assertFenceUsable(value, options = {}) {
  assertAuthorityRevocationFence(value, options);
  if (value.status === 'quarantined') fail(CODES.FENCE_IDENTITY, (options.path ?? 'authorityRevocationFence') + '.status', 'Quarantined fence is not usable authority');
  const path = options.path ?? 'authorityRevocationFence';
  if (value.sourceKind === 'principal') {
    const principal = options.principal;
    if (!principal || principal.principalId !== value.principalId) fail(CODES.REFERENCE, `${path}.principalId`, 'Principal source is missing');
    if (value.sourceVersion >= principal.version) fail(CODES.FENCE_VERSION, `${path}.sourceVersion`, 'sourceVersion must precede the current source version');
  } else if (value.sourceKind === 'membership') {
    const member = options.membership;
    if (!member || member.workspaceId !== value.scope.workspaceId || member.principalId !== value.principalId) fail(CODES.REFERENCE, `${path}.principalId`, 'Membership source is missing');
    if (value.sourceVersion >= member.version) fail(CODES.FENCE_VERSION, `${path}.sourceVersion`, 'sourceVersion must precede the current source version');
  } else {
    const delegation = options.delegation ?? findDelegation(options, value.delegationId);
    if (!delegation || delegation.delegationId !== value.delegationId || delegation.workspaceId !== value.scope.workspaceId) fail(CODES.REFERENCE, `${path}.delegationId`, 'Delegation source is missing or scope-mismatched');
    if (value.sourceVersion >= delegation.version) fail(CODES.FENCE_VERSION, `${path}.sourceVersion`, 'sourceVersion must precede the current source version');
  }
  return value;
}

export function assertBootstrapState(value, options = {}) {
  const path = options.path ?? 'bootstrapState';
  assertFields(value, path, ['bootstrapPrincipalId', 'workspaceId', 'ownerPrincipalId', 'rootFingerprint', 'completedAt'], ['bootstrapPrincipalId', 'workspaceId', 'ownerPrincipalId', 'rootFingerprint', 'completedAt']);
  id(value.bootstrapPrincipalId, `${path}.bootstrapPrincipalId`);
  id(value.workspaceId, `${path}.workspaceId`);
  id(value.ownerPrincipalId, `${path}.ownerPrincipalId`);
  str(value.rootFingerprint, `${path}.rootFingerprint`);
  timestamp(value.completedAt, `${path}.completedAt`);
  return value;
}

export function assertAuthorizationContext(value, options = {}) {
  const path = options.path ?? 'authorizationContext';
  assertFields(value, path,
    ['connectionId', 'actorPrincipalId', 'actorType', 'workspaceId', 'requestedByPrincipalId', 'delegationId', 'authorizationRevision', 'principalVersion', 'membershipVersion', 'delegationVersion', 'workspacePolicyVersion', 'managementScope'],
    ['connectionId', 'actorPrincipalId', 'actorType', 'workspaceId', 'requestedByPrincipalId', 'delegationId', 'authorizationRevision', 'principalVersion', 'membershipVersion', 'delegationVersion', 'workspacePolicyVersion']);
  id(value.connectionId, `${path}.connectionId`);
  id(value.actorPrincipalId, `${path}.actorPrincipalId`);
  enumeration(value.actorType, ACTOR_TYPES, `${path}.actorType`);
  if (value.workspaceId !== null) id(value.workspaceId, `${path}.workspaceId`);
  nullableId(value.requestedByPrincipalId, `${path}.requestedByPrincipalId`);
  nullableId(value.delegationId, `${path}.delegationId`);
  nonNegative(value.authorizationRevision, `${path}.authorizationRevision`);
  version(value.principalVersion, `${path}.principalVersion`);
  if (value.membershipVersion !== null) version(value.membershipVersion, `${path}.membershipVersion`);
  if (value.delegationVersion !== null) version(value.delegationVersion, `${path}.delegationVersion`);
  if (value.workspacePolicyVersion !== null) nonNegative(value.workspacePolicyVersion, `${path}.workspacePolicyVersion`);
  if (value.managementScope !== undefined) enumeration(value.managementScope, MANAGEMENT_SCOPES, `${path}.managementScope`);
  if (value.actorType === 'user' && value.requestedByPrincipalId !== value.actorPrincipalId) fail(CODES.COMBINATION, `${path}.requestedByPrincipalId`, 'User context requestedBy must equal actor');
  if (value.actorType === 'system' && (value.requestedByPrincipalId !== null || value.delegationId !== null)) fail(CODES.COMBINATION, `${path}.requestedByPrincipalId`, 'System context cannot be delegated');
  if (value.delegationId !== null) {
    if (value.actorType !== 'agent') fail(CODES.COMBINATION, `${path}.delegationId`, 'Only agent contexts can use delegation');
    if (value.delegationVersion === null || value.requestedByPrincipalId === null || value.workspaceId === null) fail(CODES.COMBINATION, `${path}.delegationId`, 'Delegated context requires delegationVersion, requestedBy, and workspaceId');
  } else if (value.delegationVersion !== null) {
    fail(CODES.COMBINATION, `${path}.delegationVersion`, 'delegationVersion requires delegationId');
  }
  if (value.workspaceId === null && value.membershipVersion !== null) fail(CODES.COMBINATION, `${path}.membershipVersion`, 'Global context cannot carry membershipVersion');
  return value;
}

export function assertDomainEvent(value, options = {}) {
  const path = options.path ?? 'event';
  assertFields(value, path,
    ['eventId', 'sequence', 'revision', 'scope', 'workspaceId', 'type', 'schemaVersion', 'actorPrincipalId', 'source', 'taskId', 'executionId', 'artifactId', 'correlationId', 'causationId', 'audience', 'time', 'data'],
    ['eventId', 'sequence', 'revision', 'scope', 'workspaceId', 'type', 'schemaVersion', 'actorPrincipalId', 'source', 'taskId', 'executionId', 'artifactId', 'correlationId', 'causationId', 'audience', 'time', 'data']);
  id(value.eventId, `${path}.eventId`);
  version(value.sequence, `${path}.sequence`);
  version(value.revision, `${path}.revision`);
  enumeration(value.scope, EVENT_SCOPES, `${path}.scope`);
  if (value.scope === 'system') {
    if (value.workspaceId !== null) fail(CODES.COMBINATION, `${path}.workspaceId`, 'System event requires workspaceId=null');
  } else id(value.workspaceId, `${path}.workspaceId`);
  str(value.type, `${path}.type`);
  version(value.schemaVersion, `${path}.schemaVersion`);
  nullableId(value.actorPrincipalId, `${path}.actorPrincipalId`);
  enumeration(value.source, EVENT_SOURCES, `${path}.source`);
  nullableId(value.taskId, `${path}.taskId`);
  nullableId(value.executionId, `${path}.executionId`);
  nullableId(value.artifactId, `${path}.artifactId`);
  nullableId(value.correlationId, `${path}.correlationId`);
  nullableId(value.causationId, `${path}.causationId`);
  enumeration(value.audience, EVENT_AUDIENCES, `${path}.audience`);
  timestamp(value.time, `${path}.time`);
  assertJson(value.data, `${path}.data`);
  assertByteLimit(value.data, `${path}.data`, EVENT_MAX_BYTES);
  assertByteLimit(value, path, EVENT_MAX_BYTES);
  return value;
}

function assertResultRef(value, path) {
  assertFields(value, path, ['taskId', 'executionId', 'artifactId'], []);
  for (const key of ['taskId', 'executionId', 'artifactId']) if (Object.hasOwn(value, key)) id(value[key], `${path}.${key}`);
}

export function computeRequestScopeHash({ workspaceId, actorPrincipalId, delegationId, operation, clientRequestKey }) {
  id(workspaceId, 'scope.workspaceId');
  id(actorPrincipalId, 'scope.actorPrincipalId');
  if (delegationId !== null) id(delegationId, 'scope.delegationId');
  str(operation, 'scope.operation');
  str(clientRequestKey, 'scope.clientRequestKey');
  return createHash('sha256').update(JSON.stringify({ workspaceId, actorPrincipalId, delegationId, operation, clientRequestKey })).digest('hex');
}

export function assertRequestRecord(value, options = {}) {
  const path = options.path ?? 'requestRecord';
  assertFields(value, path,
    ['requestRecordId', 'scopeHash', 'workspaceId', 'actorPrincipalId', 'delegationId', 'operation', 'clientRequestKey', 'inputHash', 'resultRef', 'resultSnapshot', 'resultBytes', 'authorizationRevision', 'createdAt', 'status'],
    ['requestRecordId', 'scopeHash', 'workspaceId', 'actorPrincipalId', 'delegationId', 'operation', 'clientRequestKey', 'inputHash', 'resultRef', 'resultSnapshot', 'resultBytes', 'authorizationRevision', 'createdAt', 'status']);
  id(value.requestRecordId, `${path}.requestRecordId`);
  if (!HASH_RE.test(value.scopeHash)) fail(CODES.FIELD, `${path}.scopeHash`, 'scopeHash must be a lowercase SHA-256 hex digest');
  id(value.workspaceId, `${path}.workspaceId`);
  id(value.actorPrincipalId, `${path}.actorPrincipalId`);
  nullableId(value.delegationId, `${path}.delegationId`);
  str(value.operation, `${path}.operation`);
  str(value.clientRequestKey, `${path}.clientRequestKey`);
  if (!HASH_RE.test(value.inputHash)) fail(CODES.FIELD, `${path}.inputHash`, 'inputHash must be a lowercase SHA-256 hex digest');
  assertResultRef(value.resultRef, `${path}.resultRef`);
  assertJson(value.resultSnapshot, `${path}.resultSnapshot`);
  const bytes = Buffer.byteLength(JSON.stringify(value.resultSnapshot));
  if (bytes > RESULT_MAX_BYTES) fail(CODES.FIELD, `${path}.resultSnapshot`, 'resultSnapshot exceeds 64 KiB');
  if (!Number.isSafeInteger(value.resultBytes) || value.resultBytes !== bytes) fail(CODES.FIELD, `${path}.resultBytes`, 'resultBytes does not match resultSnapshot');
  nonNegative(value.authorizationRevision, `${path}.authorizationRevision`);
  timestamp(value.createdAt, `${path}.createdAt`);
  enumeration(value.status, REQUEST_STATUSES, `${path}.status`);
  const expectedScope = computeRequestScopeHash({
    workspaceId: value.workspaceId,
    actorPrincipalId: value.actorPrincipalId,
    delegationId: value.delegationId,
    operation: value.operation,
    clientRequestKey: value.clientRequestKey,
  });
  if (value.scopeHash !== expectedScope) fail(CODES.FIELD, `${path}.scopeHash`, 'scopeHash does not match request scope');
  return value;
}

export function effectiveMembershipStatus(principal, workspace, member, fences = []) {
  if (member.status === 'revoked') return 'revoked';
  const membershipKey = canonicalSourceKey('membership', member.workspaceId, member.principalId);
  if (fences.some(fence => fence.sourceKind === 'membership' && fence.sourceKey === membershipKey && fence.sourceVersion === member.version)) return 'revoked';
  if (principal.deletedAt !== null) return 'revoked';
  const principalKey = canonicalSourceKey('principal', principal.principalId);
  if (fences.some(fence => fence.sourceKind === 'principal' && fence.sourceKey === principalKey && fence.sourceVersion === principal.version)) return 'revoked';
  if (principal.status !== 'active') return 'suspended';
  if (workspace.status === 'deleted') return 'suspended';
  if (workspace.status === 'archived') return 'active';
  if (workspace.quarantineState === 'quarantined') return 'active';
  if (workspace.governanceState === 'ownerless_locked') return 'active';
  return 'active';
}

function mapById(list, field, path) {
  const map = new Map();
  for (const item of list) {
    if (map.has(item[field])) fail(CODES.DUPLICATE, `${path}.${field}`, `Duplicate ${field}`);
    map.set(item[field], item);
  }
  return map;
}
function membershipKey(workspaceId, principalId) {
  return `${workspaceId}\u0000${principalId}`;
}
function ref(map, idValue, path, label) {
  const value = map.get(idValue);
  if (!value) fail(CODES.REFERENCE, path, `Unknown ${label}: ${idValue}`);
  return value;
}

export function validateStoreV3IdentityState(state, options = {}) {
  assertRecord(state, 'state');
  for (const name of ['principals', 'workspaces', 'workspaceMembers', 'membershipRevisions', 'membershipInvites', 'delegations', 'revocationFences', 'tasks', 'executions', 'sessionBindings', 'artifacts', 'artifactReferences', 'artifactGrants', 'workspaceLeases', 'requests', 'events', 'migrationRecords']) {
    if (!Array.isArray(state[name])) fail(CODES.FIELD, `state.${name}`, 'Expected an array');
  }
  const principals = new Map(), workspaces = new Map(), memberships = new Map(), revisions = new Map(), invites = new Map(), delegations = new Map(), fences = new Map();
  state.principals.forEach((item, index) => { assertPrincipal(item, { path: `state.principals[${index}]` }); if (principals.has(item.principalId)) fail(CODES.DUPLICATE, `state.principals[${index}].principalId`, 'Duplicate principalId'); principals.set(item.principalId, item); });
  state.workspaces.forEach((item, index) => { assertWorkspace(item, { path: `state.workspaces[${index}]` }); if (workspaces.has(item.workspaceId)) fail(CODES.DUPLICATE, `state.workspaces[${index}].workspaceId`, 'Duplicate workspaceId'); workspaces.set(item.workspaceId, item); });
  state.workspaceMembers.forEach((item, index) => {
    assertWorkspaceMember(item, { path: `state.workspaceMembers[${index}]` });
    const key = membershipKey(item.workspaceId, item.principalId);
    if (memberships.has(key)) fail(CODES.DUPLICATE, `state.workspaceMembers[${index}]`, 'Duplicate workspace membership');
    memberships.set(key, item);
  });
  state.membershipRevisions.forEach((item, index) => { assertMembershipRevision(item, { path: `state.membershipRevisions[${index}]` }); if (revisions.has(item.membershipRevisionId)) fail(CODES.DUPLICATE, `state.membershipRevisions[${index}].membershipRevisionId`, 'Duplicate membershipRevisionId'); revisions.set(item.membershipRevisionId, item); });
  state.membershipInvites.forEach((item, index) => { assertMembershipInvite(item, { path: `state.membershipInvites[${index}]` }); if (invites.has(item.inviteId)) fail(CODES.DUPLICATE, `state.membershipInvites[${index}].inviteId`, 'Duplicate inviteId'); invites.set(item.inviteId, item); });
  state.delegations.forEach((item, index) => { assertDelegationGrant(item, { path: `state.delegations[${index}]` }); if (delegations.has(item.delegationId)) fail(CODES.DUPLICATE, `state.delegations[${index}].delegationId`, 'Duplicate delegationId'); delegations.set(item.delegationId, item); });
  state.revocationFences.forEach((item, index) => {
    assertAuthorityRevocationFence(item, { path: `state.revocationFences[${index}]`, delegations: state.delegations, allowQuarantinedMismatch: true });
    if (fences.has(item.fenceId)) fail(CODES.DUPLICATE, `state.revocationFences[${index}].fenceId`, 'Duplicate fenceId');
    fences.set(item.fenceId, item);
  });
  if (state.bootstrapState !== null) assertBootstrapState(state.bootstrapState, { path: 'state.bootstrapState' });

  for (const principal of principals.values()) {
    if (principal.createdByPrincipalId !== null) ref(principals, principal.createdByPrincipalId, `principal ${principal.principalId}.createdByPrincipalId`, 'principal');
    if (principal.agentProfile) {
      const registeredBy = ref(principals, principal.agentProfile.registeredByPrincipalId, `principal ${principal.principalId}.agentProfile.registeredByPrincipalId`, 'principal');
      if (registeredBy.principalType !== 'user' && registeredBy.principalType !== 'system') fail(CODES.STATE, `principal ${principal.principalId}.agentProfile.registeredByPrincipalId`, 'Agent profile must be registered by a user or system');
    }
  }
  for (const workspace of workspaces.values()) {
    ref(principals, workspace.ownerPrincipalId, `workspace ${workspace.workspaceId}.ownerPrincipalId`, 'principal');
    ref(principals, workspace.createdByPrincipalId, `workspace ${workspace.workspaceId}.createdByPrincipalId`, 'principal');
    const owners = [...memberships.values()].filter(member => member.workspaceId === workspace.workspaceId && member.role === 'owner');
    if (owners.length !== 1) fail(CODES.STATE, `workspace ${workspace.workspaceId}`, 'Workspace must have exactly one owner membership');
    const owner = owners[0];
    if (owner.principalId !== workspace.ownerPrincipalId) fail(CODES.STATE, `workspace ${workspace.workspaceId}.ownerPrincipalId`, 'Workspace owner does not match owner membership');
    const ownerPrincipal = ref(principals, workspace.ownerPrincipalId, `workspace ${workspace.workspaceId}.ownerPrincipalId`, 'principal');
    if (ownerPrincipal.principalType !== 'user') fail(CODES.STATE, `workspace ${workspace.workspaceId}.ownerPrincipalId`, 'Workspace owner must be a user');
    if (workspace.governanceState !== 'ownerless_locked') {
      if (owner.status !== 'active') fail(CODES.STATE, `workspace ${workspace.workspaceId}.ownerPrincipalId`, 'Active workspace owner membership must be active');
      if (ownerPrincipal.status !== 'active' || ownerPrincipal.deletedAt !== null) fail(CODES.STATE, `workspace ${workspace.workspaceId}.ownerPrincipalId`, 'Active workspace owner principal must be active');
    }
  }
  for (const member of memberships.values()) {
    const workspace = ref(workspaces, member.workspaceId, `membership ${member.workspaceId}/${member.principalId}.workspaceId`, 'workspace');
    const principal = ref(principals, member.principalId, `membership ${member.workspaceId}/${member.principalId}.principalId`, 'principal');
    ref(principals, member.grantedByPrincipalId, `membership ${member.workspaceId}/${member.principalId}.grantedByPrincipalId`, 'principal');
    if (principal.principalType === 'system') fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}`, 'System principals cannot have Workspace membership');
    if ((member.role === 'owner' || member.role === 'admin') && principal.principalType !== 'user') fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}.role`, 'Owner/admin membership must be a user');
    if (member.role === 'owner' && workspace.ownerPrincipalId !== member.principalId) fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}.role`, 'Only Workspace owner can hold owner role');
    const memberRevisions = [...revisions.values()].filter(rev => rev.workspaceId === member.workspaceId && rev.principalId === member.principalId);
    if (!memberRevisions.length) fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}`, 'Membership requires at least one revision');
    const last = revisions.get(member.lastMembershipRevisionId);
    if (!last) fail(CODES.REFERENCE, `membership ${member.workspaceId}/${member.principalId}.lastMembershipRevisionId`, 'Unknown membership revision');
    if (last.workspaceId !== member.workspaceId || last.principalId !== member.principalId) fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}.lastMembershipRevisionId`, 'Last revision belongs to another membership');
    const latest = memberRevisions.reduce((a, b) => a.version >= b.version ? a : b);
    if (latest.membershipRevisionId !== member.lastMembershipRevisionId || latest.version !== member.version) fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}.lastMembershipRevisionId`, 'Last revision is not the latest/current version');
    if (latest.storedStatus !== member.status || latest.role !== member.role) fail(CODES.STATE, `membership ${member.workspaceId}/${member.principalId}.lastMembershipRevisionId`, 'Last revision does not match stored membership');
  }
  for (const revision of revisions.values()) {
    ref(workspaces, revision.workspaceId, `membershipRevision ${revision.membershipRevisionId}.workspaceId`, 'workspace');
    ref(principals, revision.principalId, `membershipRevision ${revision.membershipRevisionId}.principalId`, 'principal');
    ref(principals, revision.actorPrincipalId, `membershipRevision ${revision.membershipRevisionId}.actorPrincipalId`, 'principal');
    const member = memberships.get(membershipKey(revision.workspaceId, revision.principalId));
    if (!member) fail(CODES.REFERENCE, `membershipRevision ${revision.membershipRevisionId}`, 'Membership does not exist');
    if (revision.version > member.version) fail(CODES.STATE, `membershipRevision ${revision.membershipRevisionId}.version`, 'Revision is newer than membership');
    if (revision.previousRevisionId !== null) {
      const previous = revisions.get(revision.previousRevisionId);
      if (!previous || previous.workspaceId !== revision.workspaceId || previous.principalId !== revision.principalId || previous.version >= revision.version) fail(CODES.REFERENCE, `membershipRevision ${revision.membershipRevisionId}.previousRevisionId`, 'Invalid previous revision');
    }
  }
  for (const invite of invites.values()) {
    ref(workspaces, invite.workspaceId, `invite ${invite.inviteId}.workspaceId`, 'workspace');
    const target = ref(principals, invite.targetPrincipalId, `invite ${invite.inviteId}.targetPrincipalId`, 'principal');
    const creator = ref(principals, invite.createdByPrincipalId, `invite ${invite.inviteId}.createdByPrincipalId`, 'principal');
    if (creator.principalType !== 'user') fail(CODES.STATE, `invite ${invite.inviteId}.createdByPrincipalId`, 'Invite creator must be a user');
    if (target.principalType === 'system') fail(CODES.STATE, `invite ${invite.inviteId}.targetPrincipalId`, 'System principal cannot be invited');
    if (invite.role === 'admin' && target.principalType !== 'user') fail(CODES.STATE, `invite ${invite.inviteId}.role`, 'Admin invite target must be a user');
  }
  for (const delegation of delegations.values()) {
    ref(workspaces, delegation.workspaceId, `delegation ${delegation.delegationId}.workspaceId`, 'workspace');
    const grantor = ref(principals, delegation.grantorPrincipalId, `delegation ${delegation.delegationId}.grantorPrincipalId`, 'principal');
    const delegate = ref(principals, delegation.delegatePrincipalId, `delegation ${delegation.delegationId}.delegatePrincipalId`, 'principal');
    const grantorMember = memberships.get(membershipKey(delegation.workspaceId, delegation.grantorPrincipalId));
    const delegateMember = memberships.get(membershipKey(delegation.workspaceId, delegation.delegatePrincipalId));
    if (grantor.principalType !== 'user') fail(CODES.STATE, `delegation ${delegation.delegationId}.grantorPrincipalId`, 'Delegation grantor must be a user');
    if (delegate.principalType !== 'agent') fail(CODES.STATE, `delegation ${delegation.delegationId}.delegatePrincipalId`, 'Delegation delegate must be an agent');
    if (!grantorMember) fail(CODES.REFERENCE, `delegation ${delegation.delegationId}.grantorMembershipVersion`, 'Grantor membership is missing');
    if (!delegateMember) fail(CODES.REFERENCE, `delegation ${delegation.delegationId}.delegateMembershipVersion`, 'Delegate membership is missing');
    if (delegation.grantorPrincipalVersion > grantor.version) fail(CODES.STATE, `delegation ${delegation.delegationId}.grantorPrincipalVersion`, 'Grantor principal version is from the future');
    if (delegation.delegatePrincipalVersion > delegate.version) fail(CODES.STATE, `delegation ${delegation.delegationId}.delegatePrincipalVersion`, 'Delegate principal version is from the future');
    if (delegation.grantorMembershipVersion > grantorMember.version) fail(CODES.STATE, `delegation ${delegation.delegationId}.grantorMembershipVersion`, 'Grantor membership version is from the future');
    if (delegation.delegateMembershipVersion > delegateMember.version) fail(CODES.STATE, `delegation ${delegation.delegationId}.delegateMembershipVersion`, 'Delegate membership version is from the future');
  }
  for (const fence of fences.values()) {
    if (fence.status === 'quarantined') continue;
    if (fence.sourceKind === 'principal') {
      const principal = ref(principals, fence.principalId, `fence ${fence.fenceId}.principalId`, 'principal');
      assertFenceUsable(fence, { path: `fence ${fence.fenceId}`, principal, delegations: state.delegations });
    } else if (fence.sourceKind === 'membership') {
      const member = memberships.get(membershipKey(fence.scope.workspaceId, fence.principalId));
      if (!member) fail(CODES.REFERENCE, `fence ${fence.fenceId}.principalId`, 'Membership source is missing');
      assertFenceUsable(fence, { path: `fence ${fence.fenceId}`, membership: member, delegations: state.delegations });
    } else {
      const delegation = delegations.get(fence.delegationId);
      if (!delegation) fail(CODES.REFERENCE, `fence ${fence.fenceId}.delegationId`, 'Delegation source is missing');
      assertFenceUsable(fence, { path: `fence ${fence.fenceId}`, delegation, delegations: state.delegations });
    }
  }
  if (state.bootstrapState !== null) {
    const bootstrap = state.bootstrapState;
    const bootstrapPrincipal = ref(principals, bootstrap.bootstrapPrincipalId, 'bootstrapState.bootstrapPrincipalId', 'principal');
    const workspace = ref(workspaces, bootstrap.workspaceId, 'bootstrapState.workspaceId', 'workspace');
    const owner = ref(principals, bootstrap.ownerPrincipalId, 'bootstrapState.ownerPrincipalId', 'principal');
    if (bootstrapPrincipal.principalType !== 'user') fail(CODES.STATE, 'bootstrapState.bootstrapPrincipalId', 'Bootstrap principal must be a user');
    if (bootstrapPrincipal.status !== 'active' || bootstrapPrincipal.deletedAt !== null) fail(CODES.STATE, 'bootstrapState.bootstrapPrincipalId', 'Bootstrap principal must be active');
    if (workspace.status !== 'active') fail(CODES.STATE, 'bootstrapState.workspaceId', 'Bootstrap Workspace must be active');
    if (owner.principalType !== 'user') fail(CODES.STATE, 'bootstrapState.ownerPrincipalId', 'Bootstrap owner must be a user');
    if (workspace.ownerPrincipalId !== bootstrap.ownerPrincipalId) fail(CODES.STATE, 'bootstrapState.ownerPrincipalId', 'Bootstrap owner does not match Workspace owner');
  }

  const taskIds = new Set(state.tasks.map(item => item.taskId));
  const executionIds = new Set(state.executions.map(item => item.executionId));
  const artifactIds = new Set(state.artifacts.map(item => item.artifactId));
  if (state.events.length !== state.sequence) fail(CODES.STATE, 'state.events', 'Event sequence does not match events length');
  const eventIds = new Set();
  state.events.forEach((item, index) => {
    assertDomainEvent(item, { path: `state.events[${index}]` });
    if (eventIds.has(item.eventId)) fail(CODES.DUPLICATE, `state.events[${index}].eventId`, 'Duplicate eventId');
    eventIds.add(item.eventId);
    if (item.sequence !== index + 1) fail(CODES.STATE, `state.events[${index}].sequence`, 'Event sequence is not contiguous');
    if (item.revision > state.revision) fail(CODES.STATE, `state.events[${index}].revision`, 'Event revision is newer than snapshot');
    if (item.scope === 'workspace') ref(workspaces, item.workspaceId, `state.events[${index}].workspaceId`, 'workspace');
    if (item.actorPrincipalId !== null) ref(principals, item.actorPrincipalId, `state.events[${index}].actorPrincipalId`, 'principal');
    if (item.taskId !== null && !taskIds.has(item.taskId)) fail(CODES.REFERENCE, `state.events[${index}].taskId`, 'Unknown task');
    if (item.executionId !== null && !executionIds.has(item.executionId)) fail(CODES.REFERENCE, `state.events[${index}].executionId`, 'Unknown execution');
    if (item.artifactId !== null && !artifactIds.has(item.artifactId)) fail(CODES.REFERENCE, `state.events[${index}].artifactId`, 'Unknown artifact');
  });
  const requestIds = new Set();
  state.requests.forEach((item, index) => {
    assertRequestRecord(item, { path: `state.requests[${index}]` });
    if (requestIds.has(item.requestRecordId)) fail(CODES.DUPLICATE, `state.requests[${index}].requestRecordId`, 'Duplicate requestRecordId');
    requestIds.add(item.requestRecordId);
    ref(workspaces, item.workspaceId, `state.requests[${index}].workspaceId`, 'workspace');
    ref(principals, item.actorPrincipalId, `state.requests[${index}].actorPrincipalId`, 'principal');
    if (item.delegationId !== null) {
      const delegation = ref(delegations, item.delegationId, `state.requests[${index}].delegationId`, 'delegation');
      if (delegation.workspaceId !== item.workspaceId) fail(CODES.REFERENCE, `state.requests[${index}].delegationId`, 'Request delegation is from another workspace');
    }
    if (item.authorizationRevision > state.authorizationRevision) fail(CODES.STATE, `state.requests[${index}].authorizationRevision`, 'Request authorizationRevision is newer than snapshot');
    if (item.resultRef.taskId !== undefined && !taskIds.has(item.resultRef.taskId)) fail(CODES.REFERENCE, `state.requests[${index}].resultRef.taskId`, 'Unknown task');
    if (item.resultRef.executionId !== undefined && !executionIds.has(item.resultRef.executionId)) fail(CODES.REFERENCE, `state.requests[${index}].resultRef.executionId`, 'Unknown execution');
    if (item.resultRef.artifactId !== undefined && !artifactIds.has(item.resultRef.artifactId)) fail(CODES.REFERENCE, `state.requests[${index}].resultRef.artifactId`, 'Unknown artifact');
  });
  return state;
}
