import type {
  ApiKeyRecord,
  AuditLogRecord,
  BackgroundJobRecord,
  BehavioralPolicyRecord,
  BehavioralPolicyStatus,
  ConversationRecord,
  DynamicApiRecord,
  EvolutionExperimentRecord,
  GraphEntityRecord,
  GraphRelationshipRecord,
  KnowledgePolicyRecord,
  KnowledgePolicyRuleType,
  KnowledgeSourceRecord,
  LlmTelemetryRecord,
  MemoryRecord,
  MemoryType,
  MessageRecord,
  ModelEvaluationRecord,
  ModelRecord,
  NeosApprovalRecord,
  NeosApprovalStatus,
  NeosCapabilityRecord,
  ObjectiveRecord,
  ObjectiveStatus,
  ResearchReportRecord,
  ScheduledJobRecord,
  SelfUpgradeRecord,
  SkillRecord,
  TaskEventRecord,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  TaskStepRecord,
  TenantRecord,
  ToolExecutionRecord,
  ToolRecord,
  TopicStreamRecord,
  TrainingJobRecord,
  UpgradeStatus,
} from './schema.ts';

export interface MemoryCounts {
  total: number;
  working: number;
  episodic: number;
  semantic: number;
  procedural: number;
  personal: number;
  organizational: number;
  temporal: number;
}

export interface MemorySearchResult extends MemoryRecord {
  similarity: number;
  hybridScore: number;
}

export interface MemoryQueryOptions {
  memoryType?: MemoryType;
  tenantId?: string;
  includeGlobal?: boolean;
  includeDeleted?: boolean;
  validAt?: string;
  limit?: number;
  offset?: number;
}

export interface MemorySearchOptions extends MemoryQueryOptions {
  queryText?: string;
  queryEmbeddingModel?: string;
  minScore?: number;
}

export interface NeoDatabase {
  mode: 'postgresql' | 'sqlite';
  init(): Promise<void>;
  close?(): Promise<void>;

  // Tenants & API Keys
  listTenants(): Promise<TenantRecord[]>;
  getTenantById(id: string): Promise<TenantRecord | null>;
  createTenant(input: Omit<TenantRecord, 'id' | 'created_at'>): Promise<TenantRecord>;
  updateTenant(
    id: string,
    patch: Partial<Pick<TenantRecord, 'workspace_language' | 'webhook_url' | 'webhook_secret' | 'pii_redaction' | 'rate_limit_rpm'>>
  ): Promise<TenantRecord | null>;
  listApiKeys(tenantId?: string): Promise<ApiKeyRecord[]>;
  getApiKeyById(id: string): Promise<ApiKeyRecord | null>;
  getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  createApiKey(input: Omit<ApiKeyRecord, 'id' | 'last_used_at' | 'revoked_at' | 'created_at'>): Promise<ApiKeyRecord>;
  touchApiKey(id: string): Promise<void>;
  revokeApiKey(id: string): Promise<boolean>;

  // Conversations & Messages
  listConversations(tenantId: string, limit?: number): Promise<ConversationRecord[]>;
  getConversationById(id: string, tenantId: string): Promise<ConversationRecord | null>;
  createConversation(input: Omit<ConversationRecord, 'id' | 'created_at' | 'updated_at'>): Promise<ConversationRecord>;
  deleteConversation(id: string, tenantId: string): Promise<boolean>;
  listMessages(conversationId: string, tenantId: string, limit?: number): Promise<MessageRecord[]>;
  addMessage(input: Omit<MessageRecord, 'id' | 'created_at'>): Promise<MessageRecord>;

  // Memories (All 7 Types + Temporal + Epistemic + Embedding-Space Isolation + Hybrid Retrieval)
  insertMemory(
    input: Omit<
      MemoryRecord,
      | 'id'
      | 'created_at'
      | 'importance_score'
      | 'confidence_score'
      | 'epistemic_status'
      | 'retention_policy'
      | 'valid_from'
      | 'valid_to'
      | 'superseded_by'
      | 'version'
      | 'deleted_at'
      | 'last_accessed_at'
      | 'embedding_model'
      | 'embedding_dim'
    > &
      Partial<
        Pick<
          MemoryRecord,
          | 'importance_score'
          | 'confidence_score'
          | 'epistemic_status'
          | 'retention_policy'
          | 'valid_from'
          | 'valid_to'
          | 'superseded_by'
          | 'version'
          | 'deleted_at'
          | 'last_accessed_at'
          | 'embedding_model'
          | 'embedding_dim'
        >
      >
  ): Promise<MemoryRecord>;
  getMemoryById(id: string, tenantId: string, includeGlobal?: boolean): Promise<MemoryRecord | null>;
  updateMemory(
    id: string,
    tenantId: string,
    patch: Partial<
      Pick<
        MemoryRecord,
        | 'title'
        | 'content'
        | 'topic'
        | 'structured_facts'
        | 'reliability_score'
        | 'freshness_score'
        | 'importance_score'
        | 'confidence_score'
        | 'epistemic_status'
        | 'retention_policy'
        | 'valid_from'
        | 'valid_to'
        | 'superseded_by'
        | 'embedding'
        | 'embedding_model'
        | 'embedding_dim'
      >
    >
  ): Promise<MemoryRecord | null>;
  deleteMemory(id: string, tenantId: string, hardDelete?: boolean): Promise<boolean>;
  listMemories(opts?: MemoryQueryOptions): Promise<MemoryRecord[]>;
  searchMemories(queryEmbedding: number[], opts?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  countMemories(tenantId?: string): Promise<MemoryCounts>;

  // Skills
  listSkills(): Promise<SkillRecord[]>;
  getSkillByIdOrSlug(idOrSlug: string): Promise<SkillRecord | null>;
  upsertSkill(input: Omit<SkillRecord, 'id' | 'updated_at'>): Promise<SkillRecord>;
  updateSkillById(
    id: string,
    patch: Partial<Pick<SkillRecord, 'title' | 'domain' | 'content' | 'metadata'>>
  ): Promise<SkillRecord | null>;

  // Topic Streams & Research / Sources
  listTopicStreams(): Promise<TopicStreamRecord[]>;
  createTopicStream(input: Pick<TopicStreamRecord, 'topic' | 'category' | 'interval_minutes'>): Promise<TopicStreamRecord>;
  toggleTopicStream(id: string, enabled: boolean): Promise<TopicStreamRecord | null>;
  markTopicCrawled(id: string, addedItems: number): Promise<void>;
  upsertKnowledgeSource(input: Omit<KnowledgeSourceRecord, 'id' | 'created_at'>): Promise<KnowledgeSourceRecord>;
  listKnowledgeSources(tenantId?: string, limit?: number): Promise<KnowledgeSourceRecord[]>;
  createResearchReport(input: Omit<ResearchReportRecord, 'id' | 'created_at'>): Promise<ResearchReportRecord>;
  getResearchReportById(id: string, tenantId: string): Promise<ResearchReportRecord | null>;
  listResearchReports(tenantId: string, limit?: number): Promise<ResearchReportRecord[]>;

  // Knowledge Graph
  upsertEntity(input: Omit<GraphEntityRecord, 'id' | 'created_at' | 'updated_at'>): Promise<GraphEntityRecord>;
  getEntityById(id: string, tenantId: string): Promise<GraphEntityRecord | null>;
  listEntities(tenantId: string, opts?: { entityType?: string; query?: string; limit?: number }): Promise<GraphEntityRecord[]>;
  addRelationship(input: Omit<GraphRelationshipRecord, 'id' | 'created_at'>): Promise<GraphRelationshipRecord>;
  listRelationships(tenantId: string, entityId?: string, limit?: number): Promise<GraphRelationshipRecord[]>;

  // Persistent Tasks & Agent Runtime
  createTask(
    input: Omit<TaskRecord, 'id' | 'created_at' | 'updated_at' | 'completed_at'>
  ): Promise<TaskRecord>;
  getTaskById(id: string, tenantId: string): Promise<TaskRecord | null>;
  listTasks(tenantId?: string, opts?: { status?: TaskStatus; priority?: TaskPriority; limit?: number }): Promise<TaskRecord[]>;
  updateTask(
    id: string,
    patch: Partial<
      Pick<TaskRecord, 'status' | 'plan' | 'checkpoint' | 'result' | 'verification' | 'error' | 'usage' | 'loop_signature_counts' | 'completed_at'>
    >
  ): Promise<TaskRecord | null>;
  updateTaskIfStatus(
    id: string,
    tenantId: string,
    expectedStatuses: TaskStatus[],
    patch: Partial<
      Pick<TaskRecord, 'status' | 'plan' | 'checkpoint' | 'result' | 'verification' | 'error' | 'usage' | 'loop_signature_counts' | 'completed_at'>
    >
  ): Promise<TaskRecord | null>;
  upsertTaskStep(input: Omit<TaskStepRecord, 'id'> & { id?: string }): Promise<TaskStepRecord>;
  listTaskSteps(taskId: string, tenantId: string): Promise<TaskStepRecord[]>;
  appendTaskEvent(input: Omit<TaskEventRecord, 'id' | 'created_at'>): Promise<TaskEventRecord>;
  listTaskEvents(taskId: string, tenantId: string, limit?: number): Promise<TaskEventRecord[]>;

  // Autonomous Objectives
  createObjective(
    input: Omit<ObjectiveRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ObjectiveRecord>;
  getObjectiveById(id: string, tenantId: string): Promise<ObjectiveRecord | null>;
  listObjectives(tenantId?: string, opts?: { status?: ObjectiveStatus; limit?: number }): Promise<ObjectiveRecord[]>;
  updateObjective(
    id: string,
    tenantId: string,
    patch: Partial<
      Pick<
        ObjectiveRecord,
        | 'title'
        | 'description'
        | 'priority_score'
        | 'value_score'
        | 'urgency_score'
        | 'uncertainty_score'
        | 'progress_pct'
        | 'status'
        | 'compute_used_ms'
        | 'linked_task_ids'
        | 'linked_research_ids'
        | 'knowledge_gaps'
        | 'last_evaluated_at'
      >
    >
  ): Promise<ObjectiveRecord | null>;

  // Tools Registry & Audit Executions
  listTools(): Promise<ToolRecord[]>;
  getToolById(id: string): Promise<ToolRecord | null>;
  upsertTool(input: Omit<ToolRecord, 'updated_at'>): Promise<ToolRecord>;
  recordToolExecution(input: Omit<ToolExecutionRecord, 'id' | 'created_at'>): Promise<ToolExecutionRecord>;
  listToolExecutions(tenantId?: string, limit?: number): Promise<ToolExecutionRecord[]>;

  // Models, Deployments & Evaluations
  listModels(): Promise<ModelRecord[]>;
  getModelById(id: string): Promise<ModelRecord | null>;
  upsertModel(input: Omit<ModelRecord, 'created_at'>): Promise<ModelRecord>;
  updateModel(
    id: string,
    patch: Partial<
      Pick<
        ModelRecord,
        'download_status' | 'weight_location' | 'checksum_sha256' | 'roles' | 'deployment_status' | 'health_status' | 'performance_metrics' | 'benchmark_results' | 'last_validated_at'
      >
    >
  ): Promise<ModelRecord | null>;
  deleteModel(id: string): Promise<boolean>;
  recordModelEvaluation(input: Omit<ModelEvaluationRecord, 'id' | 'created_at'>): Promise<ModelEvaluationRecord>;
  listModelEvaluations(modelId?: string, limit?: number): Promise<ModelEvaluationRecord[]>;

  // Self Upgrades & Layered Evolution & Training Jobs
  listUpgrades(): Promise<SelfUpgradeRecord[]>;
  getUpgradeById(id: string): Promise<SelfUpgradeRecord | null>;
  createUpgrade(input: Omit<SelfUpgradeRecord, 'id' | 'created_at' | 'updated_at'>): Promise<SelfUpgradeRecord>;
  updateUpgradeStatus(id: string, status: UpgradeStatus): Promise<SelfUpgradeRecord | null>;
  recordEvolutionExperiment(input: Omit<EvolutionExperimentRecord, 'id' | 'created_at'>): Promise<EvolutionExperimentRecord>;
  listEvolutionExperiments(limit?: number): Promise<EvolutionExperimentRecord[]>;
  createTrainingJob(input: Omit<TrainingJobRecord, 'id' | 'created_at' | 'finished_at'>): Promise<TrainingJobRecord>;
  updateTrainingJob(id: string, patch: Partial<Pick<TrainingJobRecord, 'status' | 'metrics' | 'dataset_size' | 'dataset_path' | 'adapter_version' | 'finished_at'>>): Promise<TrainingJobRecord | null>;
  listTrainingJobs(tenantId?: string, limit?: number): Promise<TrainingJobRecord[]>;

  // Dynamic APIs (Forge)
  listDynamicApis(tenantId?: string): Promise<DynamicApiRecord[]>;
  getDynamicApiBySlug(slug: string, tenantId?: string): Promise<DynamicApiRecord | null>;
  upsertDynamicApi(input: Omit<DynamicApiRecord, 'id' | 'call_count' | 'created_at' | 'updated_at'>): Promise<DynamicApiRecord>;
  incrementDynamicApiCalls(slug: string, tenantId: string): Promise<void>;
  toggleDynamicApi(slug: string, enabled: boolean, tenantId?: string): Promise<DynamicApiRecord | null>;

  // Background Jobs & Autonomous Scheduler
  enqueueJob(input: Pick<BackgroundJobRecord, 'queue_name' | 'job_type' | 'payload'>): Promise<BackgroundJobRecord>;
  updateJob(id: string, patch: Partial<Pick<BackgroundJobRecord, 'status' | 'result' | 'error' | 'attempts' | 'finished_at'>>): Promise<void>;
  listJobs(limit?: number): Promise<BackgroundJobRecord[]>;
  listScheduledJobs(): Promise<ScheduledJobRecord[]>;
  upsertScheduledJob(input: ScheduledJobRecord): Promise<ScheduledJobRecord>;
  updateScheduledJob(
    id: string,
    patch: Partial<Pick<ScheduledJobRecord, 'enabled' | 'interval_ms' | 'last_run_at' | 'next_run_at' | 'last_status' | 'last_error' | 'run_count'>>
  ): Promise<ScheduledJobRecord | null>;

  // Telemetry & Audit Logs
  recordTelemetry(input: Omit<LlmTelemetryRecord, 'id' | 'created_at'>): Promise<void>;
  listTelemetry(limit?: number, tenantId?: string): Promise<LlmTelemetryRecord[]>;
  getTelemetrySummary(tenantId?: string): Promise<{
    totalCalls: number;
    successRate: number;
    totalTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
    byProvider: Array<{ provider: string; model: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>;
  }>;
  recordAuditLog(input: Omit<AuditLogRecord, 'id' | 'created_at'>): Promise<void>;
  listAuditLogs(limit?: number, tenantId?: string): Promise<AuditLogRecord[]>;

  // Admin Config
  getAdminConfig(key: string): Promise<string | null>;
  setAdminConfig(key: string, value: string): Promise<void>;
  setAdminConfigIfAbsent(key: string, value: string): Promise<boolean>;

  // Knowledge Policies (Trusted/Blocked Domains & Feed Sources)
  listKnowledgePolicies(tenantId?: string, ruleType?: KnowledgePolicyRuleType): Promise<KnowledgePolicyRecord[]>;
  upsertKnowledgePolicy(
    input: Omit<KnowledgePolicyRecord, 'id' | 'created_at'>
  ): Promise<KnowledgePolicyRecord>;
  updateKnowledgePolicy(
    id: string,
    patch: Partial<Pick<KnowledgePolicyRecord, 'enabled' | 'min_reliability' | 'revalidation_hours' | 'etag' | 'last_modified' | 'last_fetched_at' | 'metadata'>>
  ): Promise<KnowledgePolicyRecord | null>;
  deleteKnowledgePolicy(id: string): Promise<boolean>;

  // Behavioral Policies (Layer 3 Versioned Intelligence Policies)
  listBehavioralPolicies(limit?: number): Promise<BehavioralPolicyRecord[]>;
  getActiveBehavioralPolicy(): Promise<BehavioralPolicyRecord | null>;
  createBehavioralPolicy(
    input: Omit<BehavioralPolicyRecord, 'id' | 'created_at'>
  ): Promise<BehavioralPolicyRecord>;
  updateBehavioralPolicyStatus(
    id: string,
    status: BehavioralPolicyStatus,
    candidateMetrics?: Record<string, unknown>
  ): Promise<BehavioralPolicyRecord | null>;

  // Deep Neos Capabilities & Human Confirmation Approvals
  listNeosCapabilities(tenantId: string, enabledOnly?: boolean): Promise<NeosCapabilityRecord[]>;
  upsertNeosCapability(
    input: Omit<NeosCapabilityRecord, 'id' | 'created_at' | 'last_synced_at'>
  ): Promise<NeosCapabilityRecord>;
  deleteNeosCapability(id: string, tenantId: string): Promise<boolean>;
  listNeosApprovals(tenantId: string, status?: NeosApprovalStatus, limit?: number): Promise<NeosApprovalRecord[]>;
  getNeosApprovalById(id: string, tenantId: string): Promise<NeosApprovalRecord | null>;
  createNeosApproval(
    input: Omit<NeosApprovalRecord, 'id' | 'created_at' | 'decided_at'>
  ): Promise<NeosApprovalRecord>;
  updateNeosApproval(
    id: string,
    tenantId: string,
    patch: Partial<Pick<NeosApprovalRecord, 'status' | 'decision_by' | 'decision_note' | 'execution_result' | 'decided_at'>>
  ): Promise<NeosApprovalRecord | null>;
}
