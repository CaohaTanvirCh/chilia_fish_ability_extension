/** Phase 2.1A Contracts v3. Independent from v2.d.ts. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type PrincipalId = string;
export type WorkspaceId = string;
export type TaskId = string;
export type ExecutionId = string;
export type ArtifactId = string;
export type DelegationId = string;
export type LeaseId = string;
export type EventId = string;
export type BindingId = string;
export type RequestRecordId = string;
export type MembershipRevisionId = string;
export type InviteId = string;
export type FenceId = string;

export type PrincipalType = 'user' | 'agent' | 'system';
export type PrincipalStatus = 'active' | 'disabled';
export type ConnectorKind = 'local' | 'remote' | 'system';
export type WorkspaceStatus = 'active' | 'archived' | 'deleted';
export type RootStatus = 'bound' | 'unbound';
export type WorkspaceBoundaryEnforcement = 'cooperative' | 'os-enforced';
export type QuarantineState = 'normal' | 'quarantined';
export type IsolationPolicy = 'mutex' | 'git-worktree' | 'directory-copy';
export type GovernanceState = 'normal' | 'ownerless_locked';
export type MemberRole = 'owner' | 'admin' | 'operator' | 'viewer';
export type MemberStoredStatus = 'active' | 'revoked';
export type MembershipEffectiveStatus = 'active' | 'suspended' | 'revoked';
export type InviteRole = 'admin' | 'operator' | 'viewer';
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type DelegationScope = 'task:read' | 'task:create' | 'task:control'
  | 'execution:read' | 'execution:create' | 'execution:control'
  | 'artifact:read' | 'artifact:write';
export type DelegationStatus = 'active' | 'revoked' | 'expired';
export type ResourceScopeKind = 'workspace' | 'tasks' | 'artifacts';
export type FenceSourceKind = 'principal' | 'membership' | 'delegation';
export type FenceScopeKind = 'global' | 'workspace';
export type FenceCause = 'disabled' | 'deleted' | 'revoked' | 'expired';
export type FenceStatus = 'pending' | 'reconciling' | 'completed' | 'failed' | 'quarantined';
export type EventScope = 'workspace' | 'system';
export type EventSource = 'user' | 'agent' | 'hub' | 'executor' | 'system';
export type EventAudience = 'tenant' | 'admin' | 'system';
export type ActorType = 'user' | 'agent' | 'system';
export type RequestStatus = 'committed';

export type ContractsV3ErrorCode =
  | 'CONTRACT_REQUIRED_FIELD'
  | 'CONTRACT_INVALID_FIELD'
  | 'CONTRACT_INVALID_ENUM'
  | 'CONTRACT_INVALID_ID'
  | 'CONTRACT_INVALID_TIME'
  | 'CONTRACT_INVALID_VERSION'
  | 'CONTRACT_UNKNOWN_FIELD'
  | 'CONTRACT_INVALID_COMBINATION'
  | 'CONTRACT_DUPLICATE_KEY'
  | 'CONTRACT_INVALID_REFERENCE'
  | 'CONTRACT_INVALID_SOURCE_KEY'
  | 'CONTRACT_FENCE_IDENTITY_MISMATCH'
  | 'CONTRACT_FENCE_SOURCE_VERSION'
  | 'CONTRACT_DELEGATION_SECONDARY'
  | 'CONTRACT_SCOPE_INVALID'
  | 'CONTRACT_STATE_INCONSISTENT';

export declare const CONTRACT_ERROR_CODES: Readonly<Record<string, ContractsV3ErrorCode>>;
export declare const V3_SCHEMA_VERSION: 3;

export declare class ContractsV3Error extends Error {
  readonly code: ContractsV3ErrorCode;
  readonly path: string;
  readonly details?: unknown;
  constructor(code: ContractsV3ErrorCode, path: string, message: string, details?: unknown);
}

export interface ValidationOptions {
  path?: string;
  /** Store-only repair path for already-persisted quarantined Fence records. */
  allowQuarantinedMismatch?: boolean;
  delegations?: readonly unknown[];
}

export interface AgentProfile {
  registeredByPrincipalId: PrincipalId;
  connectorKind: ConnectorKind;
  capabilities: string[];
}

export interface Principal {
  principalId: PrincipalId;
  principalType: PrincipalType;
  displayName: string | null;
  status: PrincipalStatus;
  deletedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdByPrincipalId: PrincipalId | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  agentProfile?: AgentProfile;
}

export interface RootIdentity {
  volumeSerial: string;
  fileId: string;
  finalPath: string;
  observedAt: string;
}

export interface Workspace {
  workspaceId: WorkspaceId;
  name: string;
  status: WorkspaceStatus;
  ownerPrincipalId: PrincipalId;
  rootStatus: RootStatus;
  rootRef: string | null;
  rootPath: string | null;
  rootIdentity: RootIdentity | null;
  workspaceBoundaryEnforcement: WorkspaceBoundaryEnforcement;
  quarantineState: QuarantineState;
  quarantineReason: string | null;
  quarantinedAt: string | null;
  isolationPolicy: IsolationPolicy;
  governanceState: GovernanceState;
  writeEpoch: number;
  policyVersion: number;
  createdByPrincipalId: PrincipalId;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  deletedFrom: 'live' | 'archived' | null;
}

export interface WorkspaceMember {
  workspaceId: WorkspaceId;
  principalId: PrincipalId;
  role: MemberRole;
  status: MemberStoredStatus;
  version: number;
  lastMembershipRevisionId: MembershipRevisionId;
  grantedByPrincipalId: PrincipalId;
  grantedAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface MembershipRevision {
  membershipRevisionId: MembershipRevisionId;
  workspaceId: WorkspaceId;
  principalId: PrincipalId;
  version: number;
  storedStatus: MemberStoredStatus;
  role: MemberRole;
  actorPrincipalId: PrincipalId;
  time: string;
  reason: string | null;
  previousRevisionId: MembershipRevisionId | null;
}

export interface MembershipInvite {
  inviteId: InviteId;
  workspaceId: WorkspaceId;
  targetPrincipalId: PrincipalId;
  role: InviteRole;
  tokenHash: string;
  status: InviteStatus;
  createdByPrincipalId: PrincipalId;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface WorkspaceResourceScope {
  kind: 'workspace';
  taskIds?: [];
  artifactIds?: [];
}
export interface TasksResourceScope {
  kind: 'tasks';
  taskIds: TaskId[];
  artifactIds?: [];
}
export interface ArtifactsResourceScope {
  kind: 'artifacts';
  artifactIds: ArtifactId[];
  taskIds?: [];
}
export type ResourceScope = WorkspaceResourceScope | TasksResourceScope | ArtifactsResourceScope;

export interface DelegationGrant {
  delegationId: DelegationId;
  workspaceId: WorkspaceId;
  grantorPrincipalId: PrincipalId;
  delegatePrincipalId: PrincipalId;
  scopes: DelegationScope[];
  resourceScope: ResourceScope;
  status: DelegationStatus;
  version: number;
  grantorPrincipalVersion: number;
  grantorMembershipVersion: number;
  delegatePrincipalVersion: number;
  delegateMembershipVersion: number;
  parentDelegationId: null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: PrincipalId | null;
  revokeReason: string | null;
}

export interface FenceScope {
  kind: FenceScopeKind;
  workspaceId: WorkspaceId | null;
}

export interface AuthorityRevocationFence {
  fenceId: FenceId;
  sourceKind: FenceSourceKind;
  sourceKey: string;
  sourceVersion: number;
  scope: FenceScope;
  principalId: PrincipalId | null;
  delegationId: DelegationId | null;
  cause: FenceCause;
  effectiveAt: string;
  authorizationRevision: number;
  status: FenceStatus;
  processedTaskIds: TaskId[];
  processedGrantIds: string[];
  lastError: string | null;
  quarantineReason: string | null;
  diagnostics: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface BootstrapState {
  bootstrapPrincipalId: PrincipalId;
  workspaceId: WorkspaceId;
  ownerPrincipalId: PrincipalId;
  rootFingerprint: string;
  completedAt: string;
}

export interface AuthorizationContext {
  connectionId: string;
  actorPrincipalId: PrincipalId;
  actorType: ActorType;
  workspaceId: WorkspaceId | null;
  requestedByPrincipalId: PrincipalId | null;
  delegationId: DelegationId | null;
  authorizationRevision: number;
  principalVersion: number;
  membershipVersion: number | null;
  delegationVersion: number | null;
  workspacePolicyVersion: number | null;
  managementScope?: 'multi_workspace';
}

export interface DomainEvent {
  eventId: EventId;
  sequence: number;
  revision: number;
  scope: EventScope;
  workspaceId: WorkspaceId | null;
  type: string;
  schemaVersion: number;
  actorPrincipalId: PrincipalId | null;
  source: EventSource;
  taskId: TaskId | null;
  executionId: ExecutionId | null;
  artifactId: ArtifactId | null;
  correlationId: string | null;
  causationId: string | null;
  audience: EventAudience;
  time: string;
  data: JsonValue;
}

export interface RequestResultRef {
  taskId?: TaskId;
  executionId?: ExecutionId;
  artifactId?: ArtifactId;
}

export interface RequestRecord {
  requestRecordId: RequestRecordId;
  scopeHash: string;
  workspaceId: WorkspaceId;
  actorPrincipalId: PrincipalId;
  delegationId: DelegationId | null;
  operation: string;
  clientRequestKey: string;
  inputHash: string;
  resultRef: RequestResultRef;
  resultSnapshot: JsonValue;
  resultBytes: number;
  authorizationRevision: number;
  createdAt: string;
  status: RequestStatus;
}

export interface StoreV3IdentityState {
  version: 3;
  revision: number;
  sequence: number;
  authorizationRevision: number;
  bootstrapState: BootstrapState | null;
  authorizationState: { authorizationRevision: number };
  principals: Principal[];
  workspaces: Workspace[];
  workspaceMembers: WorkspaceMember[];
  membershipRevisions: MembershipRevision[];
  membershipInvites: MembershipInvite[];
  delegations: DelegationGrant[];
  revocationFences: AuthorityRevocationFence[];
  tasks: unknown[];
  executions: unknown[];
  artifacts: unknown[];
  requests: RequestRecord[];
  events: DomainEvent[];
}

export declare function assertPrincipal(value: unknown, options?: ValidationOptions): asserts value is Principal;
export declare function assertWorkspace(value: unknown, options?: ValidationOptions): asserts value is Workspace;
export declare function assertWorkspaceMember(value: unknown, options?: ValidationOptions): asserts value is WorkspaceMember;
export declare function assertMembershipRevision(value: unknown, options?: ValidationOptions): asserts value is MembershipRevision;
export declare function assertMembershipInvite(value: unknown, options?: ValidationOptions): asserts value is MembershipInvite;
export declare function assertDelegationGrant(value: unknown, options?: ValidationOptions): asserts value is DelegationGrant;
export declare function assertAuthorityRevocationFence(value: unknown, options?: ValidationOptions): asserts value is AuthorityRevocationFence;
export declare function assertFenceUsable(value: unknown, options?: ValidationOptions & {
  principal?: Principal;
  membership?: WorkspaceMember;
  delegation?: DelegationGrant;
}): asserts value is AuthorityRevocationFence;
export declare function assertBootstrapState(value: unknown, options?: ValidationOptions): asserts value is BootstrapState;
export declare function assertAuthorizationContext(value: unknown, options?: ValidationOptions): asserts value is AuthorizationContext;
export declare function assertDomainEvent(value: unknown, options?: ValidationOptions): asserts value is DomainEvent;
export declare function assertRequestRecord(value: unknown, options?: ValidationOptions): asserts value is RequestRecord;
export declare function canonicalSourceKey(sourceKind: 'principal' | 'delegation', id: string): string;
export declare function canonicalSourceKey(sourceKind: 'membership', workspaceId: string, principalId: string): string;
export declare function parseCanonicalSourceKey(sourceKey: string, path?: string): {
  sourceKind: FenceSourceKind;
  principalId: PrincipalId | null;
  workspaceId: WorkspaceId | null;
  delegationId: DelegationId | null;
};
export declare function computeRequestScopeHash(input: {
  workspaceId: string;
  actorPrincipalId: string;
  delegationId: string | null;
  operation: string;
  clientRequestKey: string;
}): string;
export declare function effectiveMembershipStatus(
  principal: Principal,
  workspace: Workspace,
  member: WorkspaceMember,
  fences?: readonly AuthorityRevocationFence[],
): MembershipEffectiveStatus;
export declare function validateStoreV3IdentityState(state: unknown, options?: ValidationOptions): StoreV3IdentityState;
