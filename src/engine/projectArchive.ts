import JSZip from 'jszip';
import type {
  AuditEvent,
  AutoDecisionEntry,
  ColumnConfig,
  DatasetRow,
  DatasetState,
  LockedBaseline,
  TcpConfig,
  TemporalConfig,
  VsgEntry,
} from './types';

const CURRENT_ARCHIVE_SCHEMA = 2;
const LEGACY_ARCHIVE_APP_VERSION = '5.2.0';
const MAX_ARCHIVE_ENTRIES = 3;
const MAX_DATASET_COLUMNS = 512;
const MAX_DATASET_ROWS = 2_000_000;

export const EBPROJ_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxRows: MAX_DATASET_ROWS,
  maxColumns: MAX_DATASET_COLUMNS,
  maxEntries: MAX_ARCHIVE_ENTRIES,
});

const DOMAIN_TYPES = ['energy', 'manufacturing', 'water', 'healthcare', 'finance', 'environment', 'custom'] as const;
const COLUMN_ROLES = ['time', 'target', 'predictor', 'static_factor', 'group', 'weight', 'ignore'] as const;
const QUANTITY_TYPES = ['flow', 'stock', 'rate', 'quality', 'index'] as const;
const AGGREGATIONS = ['sum', 'last', 'time_weighted_mean', 'mean', 'median'] as const;
const GRANULARITIES = ['15min', 'hourly', 'daily', 'monthly'] as const;
const MODES = ['AUTO', 'USER_OVERRIDE'] as const;
const INCLUSION_STATES = ['force_include', 'candidate', 'analysis_only', 'exclude'] as const;
const SELECTION_PHASES = ['pre_test', 'post_test'] as const;
const PROVENANCE = ['pre_registered', 'post_hoc'] as const;
const TEST_FAMILY_IDS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14'] as const;
const THRESHOLD_PROFILES = ['ashrae14', 'ipmvp', 'iso50015', 'spc', 'awwa_water', 'healthcare_kpi', 'iso14064', 'basel_sr11_7', 'custom'] as const;
const CORRECTION_METHODS = ['none', 'bonferroni', 'holm', 'bh', 'by'] as const;
const CORRECTION_SCOPES = ['per_test_per_target', 'per_target', 'global', 'per_variable'] as const;
const DECISION_RULES = ['p_only', 'p_and_effect_size', 'ci_based', 'equivalence'] as const;
const EFFORT_PROFILES = ['fast', 'standard', 'thorough'] as const;
const ACTION_POLICIES = ['flag_only', 'ask_user', 'auto_apply'] as const;
const EXPECTED_SIGNS = ['+', '-', 'free', 'non_monotonic'] as const;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_ZIP_NAMES = new Set(['manifest.json', 'data/', 'data/dataset_rows.json']);

interface ZipEntryStat {
  compressedSize: number;
  uncompressedSize: number;
}

interface ZipMetadata {
  entryStats: Map<string, ZipEntryStat>;
}

function invalidArchive(message: string): never {
  throw new Error(`Invalid .ebproj archive: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalidArchive(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidArchive(`${label} must be a plain JSON object.`);
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) invalidArchive(`${label} contains an unsafe property name.`);
  }
  return value;
}

function expectArray(value: unknown, label: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) invalidArchive(`${label} must be an array.`);
  if (value.length > maxLength) invalidArchive(`${label} exceeds the ${maxLength}-item limit.`);
  return value;
}

function expectString(value: unknown, label: string, maxLength = 4096, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) {
    invalidArchive(`${label} must be a ${allowEmpty ? 'string' : 'non-empty string'} of at most ${maxLength} characters.`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, label: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalidArchive(`${label} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function expectSafeInteger(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalidArchive(`${label} must be an integer in [${min}, ${max}].`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalidArchive(`${label} must be a boolean.`);
  return value;
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalidArchive(`${label} has an unsupported value.`);
  }
  return value as T;
}

function expectNullableString(value: unknown, label: string, maxLength = 4096): string | null {
  return value === null ? null : expectString(value, label, maxLength, true);
}

function safeEntries(value: unknown, label: string, maxEntries: number): [string, unknown][] {
  const record = expectRecord(value, label);
  const entries = Object.entries(record);
  if (entries.length > maxEntries) invalidArchive(`${label} exceeds the ${maxEntries}-entry limit.`);
  for (const [key] of entries) {
    if (!key || key.length > 512 || DANGEROUS_KEYS.has(key)) invalidArchive(`${label} contains an unsafe key.`);
  }
  return entries;
}

function expectStringArray(
  value: unknown,
  label: string,
  maxLength: number,
  allowedValues?: ReadonlySet<string>
): string[] {
  const values = expectArray(value, label, maxLength).map((item, index) =>
    expectString(item, `${label}[${index}]`, 512)
  );
  if (allowedValues && values.some((item) => !allowedValues.has(item))) {
    invalidArchive(`${label} contains an unknown identifier.`);
  }
  return values;
}

function expectNumberArray(value: unknown, label: string, maxLength: number): number[] {
  return expectArray(value, label, maxLength).map((item, index) => expectFiniteNumber(item, `${label}[${index}]`));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) invalidArchive('Web Crypto SHA-256 is unavailable in this runtime.');
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function littleEndianView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Inspect ZIP central-directory records before JSZip can inflate any entry.
 * Only the exact project file set is supported; ZIP64 and multi-disk archives fail closed.
 */
function inspectZipArchive(bytes: Uint8Array): ZipMetadata {
  const view = littleEndianView(bytes);
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const minimumEocdLength = 22;
  if (bytes.byteLength < minimumEocdLength) invalidArchive('ZIP end-of-central-directory record is missing.');

  const earliestSearchOffset = Math.max(0, bytes.byteLength - minimumEocdLength - 0xffff);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - minimumEocdLength; offset >= earliestSearchOffset; offset--) {
    if (view.getUint32(offset, true) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) invalidArchive('ZIP end-of-central-directory record is missing.');

  const commentLength = view.getUint16(eocdOffset + 20, true);
  if (eocdOffset + minimumEocdLength + commentLength !== bytes.byteLength) {
    invalidArchive('ZIP has trailing data or a malformed archive comment.');
  }
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    invalidArchive('Multi-disk ZIP archives are not supported.');
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    invalidArchive('ZIP64 archives are not supported by the project reader.');
  }
  if (entryCount < 2 || entryCount > MAX_ARCHIVE_ENTRIES) {
    invalidArchive(`ZIP entry count must be between 2 and ${MAX_ARCHIVE_ENTRIES}.`);
  }
  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
    invalidArchive('ZIP central-directory bounds are invalid.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const names = new Set<string>();
  const entryStats = new Map<string, ZipEntryStat>();
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocdOffset || view.getUint32(cursor, true) !== centralSignature) {
      invalidArchive('ZIP central-directory entry is malformed.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > eocdOffset || nameLength === 0) invalidArchive('ZIP central-directory entry bounds are invalid.');
    if ((flags & 0x0001) !== 0) invalidArchive('Encrypted ZIP entries are not supported.');
    if (compressionMethod !== 0 && compressionMethod !== 8) invalidArchive('ZIP entry uses an unsupported compression method.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      invalidArchive('ZIP64 entry sizes are not supported.');
    }

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      invalidArchive('ZIP entry name is not valid UTF-8.');
    }
    if (!ALLOWED_ZIP_NAMES.has(name)) invalidArchive(`Unexpected ZIP entry '${name}'.`);
    if (names.has(name)) invalidArchive(`Duplicate ZIP entry '${name}' is not allowed.`);
    names.add(name);

    const isDirectory = name.endsWith('/');
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) invalidArchive('Symbolic-link ZIP entries are not allowed.');
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      invalidArchive('Directory entries must not contain data.');
    }
    const maxEntryBytes = name === 'manifest.json' ? EBPROJ_LIMITS.maxManifestBytes : EBPROJ_LIMITS.maxEntryBytes;
    if (uncompressedSize > maxEntryBytes) {
      invalidArchive(`ZIP entry '${name}' exceeds the uncompressed entry size limit.`);
    }
    if (compressedSize > EBPROJ_LIMITS.maxFileBytes) invalidArchive(`ZIP entry '${name}' exceeds the compressed entry size limit.`);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > EBPROJ_LIMITS.maxTotalUncompressedBytes) {
      invalidArchive('ZIP exceeds the total uncompressed size limit.');
    }

    if (localHeaderOffset + 30 > centralDirectoryOffset || view.getUint32(localHeaderOffset, true) !== localSignature) {
      invalidArchive(`ZIP entry '${name}' has an invalid local-file header.`);
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localCompressionMethod = view.getUint16(localHeaderOffset + 8, true);
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    if ((localFlags & 0x0001) !== 0 || localCompressionMethod !== compressionMethod) {
      invalidArchive(`ZIP entry '${name}' local and central metadata disagree.`);
    }
    const localNameEnd = localHeaderOffset + 30 + localNameLength;
    const dataOffset = localNameEnd + localExtraLength;
    if (dataOffset + compressedSize > centralDirectoryOffset || localNameEnd > centralDirectoryOffset) {
      invalidArchive(`ZIP entry '${name}' data bounds are invalid.`);
    }
    let localName: string;
    try {
      localName = decoder.decode(bytes.subarray(localHeaderOffset + 30, localNameEnd));
    } catch {
      invalidArchive(`ZIP entry '${name}' local name is not valid UTF-8.`);
    }
    if (localName !== name) invalidArchive(`ZIP entry '${name}' local and central names disagree.`);

    entryStats.set(name, { compressedSize, uncompressedSize });
    cursor = recordEnd;
  }

  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    invalidArchive('ZIP central-directory length does not match its entries.');
  }
  if (!names.has('manifest.json') || !names.has('data/dataset_rows.json')) {
    invalidArchive('Required manifest.json or data/dataset_rows.json entry is missing.');
  }
  return { entryStats };
}

function validateStringArrayField(value: unknown, label: string, columnNames: Set<string>, maxLength = MAX_DATASET_COLUMNS): string[] {
  const values = expectStringArray(value, label, maxLength);
  if (values.some((name) => !columnNames.has(name))) invalidArchive(`${label} references an unknown dataset column.`);
  return values;
}

function validateColumns(value: unknown): ColumnConfig[] {
  const columns = expectArray(value, 'manifest.columns', MAX_DATASET_COLUMNS);
  if (columns.length === 0) invalidArchive('manifest.columns must not be empty.');
  const names = new Set<string>();
  const parsed = columns.map((item, index) => {
    const label = `manifest.columns[${index}]`;
    const column = expectRecord(item, label);
    const name = expectString(column.name, `${label}.name`, 256);
    if (DANGEROUS_KEYS.has(name) || names.has(name)) invalidArchive(`${label}.name is unsafe or duplicated.`);
    names.add(name);
    expectEnum(column.role, COLUMN_ROLES, `${label}.role`);
    expectEnum(column.suggestedRole, COLUMN_ROLES, `${label}.suggestedRole`);
    expectEnum(column.quantityType, QUANTITY_TYPES, `${label}.quantityType`);
    expectEnum(column.aggregation, AGGREGATIONS, `${label}.aggregation`);
    expectString(column.unit, `${label}.unit`, 256, true);
    expectString(column.unitFamily, `${label}.unitFamily`, 256, true);
    expectEnum(column.availability, ['known_in_advance', 'observed_only'] as const, `${label}.availability`);
    expectEnum(column.dtype, ['datetime', 'numeric', 'categorical'] as const, `${label}.dtype`);
    expectEnum(column.roleMode, MODES, `${label}.roleMode`);
    return column as unknown as ColumnConfig;
  });
  return parsed;
}

function validateTemporal(value: unknown): TemporalConfig {
  const temporal = expectRecord(value, 'manifest.temporal');
  expectEnum(temporal.sourceGranularity, GRANULARITIES, 'manifest.temporal.sourceGranularity');
  expectEnum(temporal.targetGranularity, GRANULARITIES, 'manifest.temporal.targetGranularity');
  expectString(temporal.timezone, 'manifest.temporal.timezone', 256);
  for (const field of ['baselineStart', 'baselineEnd', 'reportingStart', 'reportingEnd']) {
    expectString(temporal[field], `manifest.temporal.${field}`, 256);
  }
  expectEnum(temporal.dstPolicy, ['utc_store_flag_dst', 'drop_ambiguous', 'keep_all'] as const, 'manifest.temporal.dstPolicy');
  expectFiniteNumber(temporal.completenessThreshold, 'manifest.temporal.completenessThreshold', 0, 1);
  return temporal as unknown as TemporalConfig;
}

function validateDatasetRows(value: unknown, columnNames: Set<string>): DatasetRow[] {
  const rows = expectArray(value, 'data/dataset_rows.json', MAX_DATASET_ROWS);
  const allowedKeys = new Set([...columnNames, 'timestamp']);
  return rows.map((item, index) => {
    const label = `data/dataset_rows.json[${index}]`;
    const row = expectRecord(item, label);
    const keys = Object.keys(row);
    if (keys.length > MAX_DATASET_COLUMNS + 1) invalidArchive(`${label} has too many fields.`);
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key) || !allowedKeys.has(key)) invalidArchive(`${label} contains an unknown or unsafe column.`);
      const cell = row[key];
      if (cell === null) continue;
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) invalidArchive(`${label}.${key} is not finite.`);
      } else if (typeof cell === 'string') {
        if (cell.length > 100_000) invalidArchive(`${label}.${key} exceeds the cell size limit.`);
      } else {
        invalidArchive(`${label}.${key} must be a string, finite number, or null.`);
      }
    }
    expectString(row.timestamp, `${label}.timestamp`, 256);
    return row as unknown as DatasetRow;
  });
}

function validateVsg(value: unknown, columnNames: Set<string>): Record<string, Record<string, VsgEntry>> {
  const output: Record<string, Record<string, VsgEntry>> = Object.create(null) as Record<string, Record<string, VsgEntry>>;
  for (const [target, rawEntries] of safeEntries(value, 'manifest.vsg_by_target', MAX_DATASET_COLUMNS)) {
    if (!columnNames.has(target)) invalidArchive(`manifest.vsg_by_target has unknown target '${target}'.`);
    const entries: Record<string, VsgEntry> = Object.create(null) as Record<string, VsgEntry>;
    for (const [columnName, rawEntry] of safeEntries(rawEntries, `manifest.vsg_by_target.${target}`, MAX_DATASET_COLUMNS)) {
      if (!columnNames.has(columnName)) invalidArchive(`VSG references unknown column '${columnName}'.`);
      const entry = expectRecord(rawEntry, `VSG ${target}.${columnName}`);
      if (entry.columnName !== columnName) invalidArchive(`VSG ${target}.${columnName} columnName does not match its key.`);
      expectEnum(entry.state, INCLUSION_STATES, `VSG ${target}.${columnName}.state`);
      expectEnum(entry.mode, MODES, `VSG ${target}.${columnName}.mode`);
      expectEnum(entry.phase, SELECTION_PHASES, `VSG ${target}.${columnName}.phase`);
      expectEnum(entry.provenance, PROVENANCE, `VSG ${target}.${columnName}.provenance`);
      expectString(entry.reason, `VSG ${target}.${columnName}.reason`, 8192, true);
      expectString(entry.rule, `VSG ${target}.${columnName}.rule`, 8192, true);
      expectString(entry.timestamp, `VSG ${target}.${columnName}.timestamp`, 256, true);
      if (entry.conflict !== null) expectString(entry.conflict, `VSG ${target}.${columnName}.conflict`, 8192, true);
      expectStringArray(entry.scopeFamilies, `VSG ${target}.${columnName}.scopeFamilies`, TEST_FAMILY_IDS.length, new Set(TEST_FAMILY_IDS));
      entries[columnName] = entry as unknown as VsgEntry;
    }
    output[target] = entries;
  }
  return output;
}

function validateTcpConfig(value: unknown, columnNames: Set<string>): TcpConfig {
  const tcp = expectRecord(value, 'manifest.tcp_config');
  expectFiniteNumber(tcp.alpha, 'manifest.tcp_config.alpha', Number.EPSILON, 1);
  expectEnum(tcp.alphaPreset, ['strict_0.01', 'standard_0.05', 'exploratory_0.10', 'custom'] as const, 'manifest.tcp_config.alphaPreset');
  expectFiniteNumber(tcp.confidenceLevel, 'manifest.tcp_config.confidenceLevel', 0, 1);
  expectEnum(tcp.correctionMethod, CORRECTION_METHODS, 'manifest.tcp_config.correctionMethod');
  expectEnum(tcp.correctionScope, CORRECTION_SCOPES, 'manifest.tcp_config.correctionScope');
  expectEnum(tcp.decisionRule, DECISION_RULES, 'manifest.tcp_config.decisionRule');
  expectEnum(tcp.effortProfile, EFFORT_PROFILES, 'manifest.tcp_config.effortProfile');
  expectEnum(tcp.outlierActionPolicy, ACTION_POLICIES, 'manifest.tcp_config.outlierActionPolicy');
  expectBoolean(tcp.includeOptionalTests, 'manifest.tcp_config.includeOptionalTests');
  expectBoolean(tcp.preRegistered, 'manifest.tcp_config.preRegistered');
  expectNullableString(tcp.preRegistrationHash, 'manifest.tcp_config.preRegistrationHash', 256);
  expectNullableString(tcp.preRegistrationTimestamp, 'manifest.tcp_config.preRegistrationTimestamp', 256);
  expectBoolean(tcp.postHocModified, 'manifest.tcp_config.postHocModified');
  expectEnum(tcp.mode, MODES, 'manifest.tcp_config.mode');

  const families = expectRecord(tcp.families, 'manifest.tcp_config.families');
  for (const familyId of TEST_FAMILY_IDS) {
    const family = expectRecord(families[familyId], `manifest.tcp_config.families.${familyId}`);
    if (family.id !== familyId) invalidArchive(`TCP family ${familyId} has a mismatched id.`);
    expectString(family.name, `TCP family ${familyId}.name`, 512);
    expectEnum(family.phase, ['pre_model', 'post_model', 'causal_group'] as const, `TCP family ${familyId}.phase`);
    expectBoolean(family.enabled, `TCP family ${familyId}.enabled`);
    expectEnum(family.gateRole, ['informational', 'warning', 'gating'] as const, `TCP family ${familyId}.gateRole`);
    expectEnum(family.actionPolicy, ACTION_POLICIES, `TCP family ${familyId}.actionPolicy`);
    if (family.alphaOverride !== null) expectFiniteNumber(family.alphaOverride, `TCP family ${familyId}.alphaOverride`, Number.EPSILON, 1);
    if (family.correctionOverride !== null) expectEnum(family.correctionOverride, CORRECTION_METHODS, `TCP family ${familyId}.correctionOverride`);
    expectEnum(family.alternative, ['two-sided', 'greater', 'less'] as const, `TCP family ${familyId}.alternative`);
    expectEnum(family.maxLagsRule, ['schwert', 'aic', 'bic', 'fixed'] as const, `TCP family ${familyId}.maxLagsRule`);
    expectSafeInteger(family.fixedLags, `TCP family ${familyId}.fixedLags`, 0, 100_000);
    expectEnum(family.deterministicTerm, ['n', 'c', 'ct', 'ctt'] as const, `TCP family ${familyId}.deterministicTerm`);
    expectSafeInteger(family.minSampleSize, `TCP family ${familyId}.minSampleSize`, 0, 10_000_000);
    for (const field of ['effectThresholdSmall', 'effectThresholdMedium', 'tostMargin']) {
      expectFiniteNumber(family[field], `TCP family ${familyId}.${field}`);
    }
    expectSafeInteger(family.bootstrapReplicates, `TCP family ${familyId}.bootstrapReplicates`, 0, 10_000_000);
    expectStringArray(family.dependencies, `TCP family ${familyId}.dependencies`, TEST_FAMILY_IDS.length, new Set(TEST_FAMILY_IDS));
    expectFiniteNumber(family.costEstimateMs, `TCP family ${familyId}.costEstimateMs`, 0);
    expectString(family.whyKeepHint, `TCP family ${familyId}.whyKeepHint`, 8192, true);
  }
  if (Object.keys(families).some((id) => !(TEST_FAMILY_IDS as readonly string[]).includes(id))) {
    invalidArchive('TCP families contain an unsupported family id.');
  }

  const signs: Record<string, Record<string, '+' | '-' | 'free' | 'non_monotonic'>> = Object.create(null) as Record<string, Record<string, '+' | '-' | 'free' | 'non_monotonic'>>;
  for (const [target, rawSigns] of safeEntries(tcp.expectedSignsByTarget, 'manifest.tcp_config.expectedSignsByTarget', MAX_DATASET_COLUMNS)) {
    if (!columnNames.has(target)) invalidArchive(`TCP expected signs reference unknown target '${target}'.`);
    const targetSigns: Record<string, '+' | '-' | 'free' | 'non_monotonic'> = Object.create(null) as Record<string, '+' | '-' | 'free' | 'non_monotonic'>;
    for (const [feature, sign] of safeEntries(rawSigns, `TCP expected signs ${target}`, MAX_DATASET_COLUMNS)) {
      if (!columnNames.has(feature)) invalidArchive(`TCP expected signs reference unknown feature '${feature}'.`);
      targetSigns[feature] = expectEnum(sign, EXPECTED_SIGNS, `TCP expected sign ${target}.${feature}`);
    }
    signs[target] = targetSigns;
  }
  return { ...tcp, expectedSignsByTarget: signs } as unknown as TcpConfig;
}

function validateAuditLog(value: unknown): AuditEvent[] {
  return expectArray(value, 'manifest.audit_log', 100_000).map((raw, index) => {
    const label = `manifest.audit_log[${index}]`;
    const entry = expectRecord(raw, label);
    expectString(entry.id, `${label}.id`, 512);
    expectString(entry.timestamp, `${label}.timestamp`, 256);
    expectString(entry.stage, `${label}.stage`, 512);
    expectString(entry.action, `${label}.action`, 2048);
    expectEnum(entry.actor, ['USER', 'AUTO', 'SYSTEM'] as const, `${label}.actor`);
    expectString(entry.detail, `${label}.detail`, 8192, true);
    return entry as unknown as AuditEvent;
  });
}

function validateAutoLog(value: unknown): AutoDecisionEntry[] {
  return expectArray(value, 'manifest.auto_log', 100_000).map((raw, index) => {
    const label = `manifest.auto_log[${index}]`;
    const entry = expectRecord(raw, label);
    expectString(entry.id, `${label}.id`, 512);
    expectString(entry.settingKey, `${label}.settingKey`, 512);
    expectString(entry.value, `${label}.value`, 2048, true);
    expectString(entry.signals, `${label}.signals`, 8192, true);
    expectString(entry.rule, `${label}.rule`, 8192, true);
    expectEnum(entry.mode, MODES, `${label}.mode`);
    expectString(entry.target, `${label}.target`, 512);
    expectString(entry.timestamp, `${label}.timestamp`, 256);
    return entry as unknown as AutoDecisionEntry;
  });
}

function validateNumericMatrix(value: unknown, label: string, maxRows = 4096, maxColumns = 4096): number[][] {
  const rows = expectArray(value, label, maxRows).map((row, rowIndex) =>
    expectNumberArray(row, `${label}[${rowIndex}]`, maxColumns)
  );
  const width = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== width)) invalidArchive(`${label} must be a rectangular numeric matrix.`);
  if (rows.length * width > 2_000_000) invalidArchive(`${label} exceeds the model matrix complexity limit.`);
  return rows;
}

function validateDecisionStump(value: unknown, label: string): void {
  const stump = expectRecord(value, label);
  expectSafeInteger(stump.featureIdx, `${label}.featureIdx`, 0, 4095);
  expectFiniteNumber(stump.threshold, `${label}.threshold`);
  expectFiniteNumber(stump.leftVal, `${label}.leftVal`);
  expectFiniteNumber(stump.rightVal, `${label}.rightVal`);
}

function validateTreeNode(value: unknown, label: string, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 32 || ++budget.nodes > 50_000) invalidArchive(`${label} exceeds the model-tree complexity limit.`);
  const node = expectRecord(value, label);
  if (Object.hasOwn(node, 'leafValue')) {
    expectFiniteNumber(node.leafValue, `${label}.leafValue`);
    if (Object.hasOwn(node, 'left') || Object.hasOwn(node, 'right') || Object.hasOwn(node, 'featureIdx')) {
      invalidArchive(`${label} leaf node contains branch fields.`);
    }
    return;
  }
  expectSafeInteger(node.featureIdx, `${label}.featureIdx`, 0, 4095);
  expectFiniteNumber(node.threshold, `${label}.threshold`);
  validateTreeNode(node.left, `${label}.left`, depth + 1, budget);
  validateTreeNode(node.right, `${label}.right`, depth + 1, budget);
}

function validateModelPayload(value: unknown, label: string, depth: number): void {
  if (depth > 4) invalidArchive(`${label} nesting exceeds the model payload limit.`);
  const payload = expectRecord(value, label);
  const kind = expectEnum(payload.kind, ['boosted_trees', 'boosted_stumps', 'bagged_trees', 'rbf_kernel', 'mlp', 'ensemble_blend'] as const, `${label}.kind`);

  if (kind === 'ensemble_blend') {
    expectFiniteNumber(payload.w1, `${label}.w1`);
    expectFiniteNumber(payload.w2, `${label}.w2`);
    validatePredictParams(payload.p1, `${label}.p1`, depth + 1);
    validatePredictParams(payload.p2, `${label}.p2`, depth + 1);
    return;
  }

  if (kind === 'bagged_trees') {
    const trees = expectArray(payload.model, `${label}.model`, 4096);
    trees.forEach((tree, treeIndex) => {
      const stumps = expectArray(tree, `${label}.model[${treeIndex}]`, 256);
      stumps.forEach((stump, stumpIndex) => validateDecisionStump(stump, `${label}.model[${treeIndex}][${stumpIndex}]`));
    });
    return;
  }

  const model = expectRecord(payload.model, `${label}.model`);
  if (kind === 'boosted_trees') {
    expectFiniteNumber(model.base, `${label}.model.base`);
    expectFiniteNumber(model.eta, `${label}.model.eta`);
    const trees = expectArray(model.trees, `${label}.model.trees`, 10_000);
    const treeBudget = { nodes: 0 };
    trees.forEach((tree, index) => validateTreeNode(tree, `${label}.model.trees[${index}]`, 0, treeBudget));
  } else if (kind === 'boosted_stumps') {
    expectFiniteNumber(model.base, `${label}.model.base`);
    expectFiniteNumber(model.lr, `${label}.model.lr`);
    const stumps = expectArray(model.stumps, `${label}.model.stumps`, 10_000);
    stumps.forEach((stump, index) => validateDecisionStump(stump, `${label}.model.stumps[${index}]`));
  } else if (kind === 'rbf_kernel') {
    const centers = validateNumericMatrix(model.centers, `${label}.model.centers`, 4096, 4096);
    const weights = expectNumberArray(model.weights, `${label}.model.weights`, 4096);
    const means = expectNumberArray(model.means, `${label}.model.means`, 4096);
    const stds = expectNumberArray(model.stds, `${label}.model.stds`, 4096);
    if (weights.length !== centers.length || stds.length !== means.length || centers.some((row) => row.length !== means.length)) {
      invalidArchive(`${label}.model RBF dimensions are inconsistent.`);
    }
    expectFiniteNumber(model.yMean, `${label}.model.yMean`);
    expectFiniteNumber(model.gamma, `${label}.model.gamma`, 0);
  } else if (kind === 'mlp') {
    const w1 = validateNumericMatrix(model.W1, `${label}.model.W1`, 4096, 4096);
    const b1 = expectNumberArray(model.b1, `${label}.model.b1`, 4096);
    const w2 = expectNumberArray(model.W2, `${label}.model.W2`, 4096);
    const means = expectNumberArray(model.means, `${label}.model.means`, 4096);
    const stds = expectNumberArray(model.stds, `${label}.model.stds`, 4096);
    if (w1.length !== b1.length || w1.length !== w2.length || (w1[0]?.length ?? 0) !== means.length || means.length !== stds.length) {
      invalidArchive(`${label}.model MLP dimensions are inconsistent.`);
    }
    if (model.Wskip !== undefined && model.Wskip !== null) {
      const skip = expectNumberArray(model.Wskip, `${label}.model.Wskip`, 4096);
      if (skip.length !== means.length) invalidArchive(`${label}.model.Wskip dimensions are inconsistent.`);
    }
    expectFiniteNumber(model.b2, `${label}.model.b2`);
    expectFiniteNumber(model.yMean, `${label}.model.yMean`);
    expectFiniteNumber(model.yStd, `${label}.model.yStd`, Number.EPSILON);
    if (payload.temporalMode !== undefined) {
      expectEnum(payload.temporalMode, ['gru_lag', 'causal_tcn', 'nbeats', 'tft', 'patchtst', 'informer'] as const, `${label}.temporalMode`);
    }
  }
}

function validatePredictParams(value: unknown, label: string, depth = 0): void {
  if (depth > 4) invalidArchive(`${label} nesting exceeds the prediction parameter limit.`);
  const params = expectRecord(value, label);
  expectString(params.family, `${label}.family`, 256);
  expectStringArray(params.features, `${label}.features`, MAX_DATASET_COLUMNS);
  const coeffs = expectArray(params.coeffs, `${label}.coeffs`, 10_000);
  coeffs.forEach((raw, index) => {
    const coefficient = expectRecord(raw, `${label}.coeffs[${index}]`);
    expectString(coefficient.term, `${label}.coeffs[${index}].term`, 512);
    expectFiniteNumber(coefficient.value, `${label}.coeffs[${index}].value`);
  });
  expectFiniteNumber(params.bestTh, `${label}.bestTh`);
  expectFiniteNumber(params.bestTc, `${label}.bestTc`);
  const medians = safeEntries(params.colMedians, `${label}.colMedians`, MAX_DATASET_COLUMNS);
  medians.forEach(([key, median]) => expectFiniteNumber(median, `${label}.colMedians.${key}`));
  expectFiniteNumber(params.meanTarget, `${label}.meanTarget`);
  expectFiniteNumber(params.oofRmse, `${label}.oofRmse`, 0);
  expectFiniteNumber(params.conformalHalfWidth, `${label}.conformalHalfWidth`, 0);
  if (params.modelPayload !== undefined && params.modelPayload !== null) {
    validateModelPayload(params.modelPayload, `${label}.modelPayload`, depth + 1);
  }
}

function validateCalibrationSummary(value: unknown, label: string): void {
  const summary = expectRecord(value, label);
  expectString(summary.method, `${label}.method`, 1024, true);
  for (const field of ['nominalCoverage', 'empiricalCoverage', 'meanWidth', 'winklerScore', 'kupiecPofP', 'christoffersenCcP']) {
    expectFiniteNumber(summary[field], `${label}.${field}`);
  }
  const regimes = expectArray(summary.regimeCoverage, `${label}.regimeCoverage`, 10_000);
  regimes.forEach((raw, index) => {
    const regime = expectRecord(raw, `${label}.regimeCoverage[${index}]`);
    expectString(regime.regime, `${label}.regimeCoverage[${index}].regime`, 512);
    expectFiniteNumber(regime.coverage, `${label}.regimeCoverage[${index}].coverage`);
    expectSafeInteger(regime.n, `${label}.regimeCoverage[${index}].n`, 0, MAX_DATASET_ROWS);
  });
}

function validateLockedBaselines(value: unknown, columnNames: Set<string>): Record<string, LockedBaseline> {
  const output: Record<string, LockedBaseline> = Object.create(null) as Record<string, LockedBaseline>;
  for (const [target, rawBaseline] of safeEntries(value, 'manifest.locked_baselines', MAX_DATASET_COLUMNS)) {
    if (!columnNames.has(target)) invalidArchive(`Locked baseline references unknown target '${target}'.`);
    const label = `manifest.locked_baselines.${target}`;
    const baseline = expectRecord(rawBaseline, label);
    expectSafeInteger(baseline.version, `${label}.version`, 1, 1_000_000);
    if (baseline.target !== target) invalidArchive(`${label}.target does not match its key.`);
    expectString(baseline.target, `${label}.target`, 256);
    expectString(baseline.modelId, `${label}.modelId`, 512);
    expectString(baseline.modelName, `${label}.modelName`, 1024);
    expectString(baseline.family, `${label}.family`, 256);
    expectString(baseline.lockedAt, `${label}.lockedAt`, 256);
    expectString(baseline.note, `${label}.note`, 8192, true);
    for (const field of ['artifactSha256', 'vsgSnapshotHash', 'tcpSnapshotHash']) {
      const digest = expectString(baseline[field], `${label}.${field}`, 128);
      if (!/^[0-9a-f]{16,128}$/i.test(digest)) invalidArchive(`${label}.${field} is not a hexadecimal digest.`);
    }
    const features = validateStringArrayField(baseline.features, `${label}.features`, columnNames);
    expectEnum(baseline.thresholdProfile, THRESHOLD_PROFILES, `${label}.thresholdProfile`);
    const window = expectRecord(baseline.trainingWindow, `${label}.trainingWindow`);
    expectString(window.start, `${label}.trainingWindow.start`, 256);
    expectString(window.end, `${label}.trainingWindow.end`, 256);
    expectSafeInteger(window.nRows, `${label}.trainingWindow.nRows`, 0, MAX_DATASET_ROWS);
    expectSafeInteger(baseline.seed, `${label}.seed`, 0, Number.MAX_SAFE_INTEGER);
    validateCalibrationSummary(baseline.calibrationSummary, `${label}.calibrationSummary`);

    const card = expectRecord(baseline.modelCard, `${label}.modelCard`);
    for (const field of ['intendedUse', 'trainingWindow', 'calibrationSummary', 'standardsNote']) {
      expectString(card[field], `${label}.modelCard.${field}`, 8192, true);
    }
    for (const field of ['features']) {
      const cardFeatures = validateStringArrayField(card[field], `${label}.modelCard.${field}`, columnNames);
      if (cardFeatures.length !== features.length) invalidArchive(`${label}.modelCard.features does not match the baseline features.`);
    }
    expectStringArray(card.assumptions, `${label}.modelCard.assumptions`, 10_000);
    expectStringArray(card.knownLimitations, `${label}.modelCard.knownLimitations`, 10_000);

    const candidate = expectRecord(baseline.candidate, `${label}.candidate`);
    if (candidate.target !== target || candidate.id !== baseline.modelId || candidate.name !== baseline.modelName) {
      invalidArchive(`${label}.candidate identity does not match its locked baseline.`);
    }
    expectString(candidate.id, `${label}.candidate.id`, 512);
    expectString(candidate.target, `${label}.candidate.target`, 256);
    expectString(candidate.name, `${label}.candidate.name`, 1024);
    expectString(candidate.family, `${label}.candidate.family`, 256);
    expectBoolean(candidate.isParametric, `${label}.candidate.isParametric`);
    expectBoolean(candidate.isNeuralNet, `${label}.candidate.isNeuralNet`);
    const candidateFeatures = validateStringArrayField(candidate.featuresUsed, `${label}.candidate.featuresUsed`, columnNames);
    if (candidateFeatures.length !== features.length) invalidArchive(`${label}.candidate.featuresUsed does not match the locked baseline features.`);
    expectFiniteNumber(candidate.oofCvRmse, `${label}.candidate.oofCvRmse`, 0);
    expectFiniteNumber(candidate.oofNmbe, `${label}.candidate.oofNmbe`);
    validateCalibrationSummary(candidate.conformalSummary, `${label}.candidate.conformalSummary`);
    validatePredictParams(candidate.predictFnParams, `${label}.candidate.predictFnParams`);
    output[target] = baseline as unknown as LockedBaseline;
  }
  return output;
}

function validateManifestAndRows(
  value: unknown,
  rows: unknown
): {
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  lockedBaselines: Record<string, LockedBaseline>;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
} {
  const manifest = expectRecord(value, 'manifest.json');
  const isCurrent = manifest.schema_version === CURRENT_ARCHIVE_SCHEMA;
  const isLegacy = manifest.schema_version === LEGACY_ARCHIVE_APP_VERSION && manifest.entries === undefined;
  if (!isCurrent && !isLegacy) invalidArchive(`unsupported schema_version '${String(manifest.schema_version)}'.`);
  if (isCurrent) expectString(manifest.app_version, 'manifest.app_version', 32);
  expectString(manifest.exported_at, 'manifest.exported_at', 256);
  if (manifest.credentials_included !== false) invalidArchive('credentials_included must be false.');

  const datasetRef = expectRecord(manifest.dataset_ref, 'manifest.dataset_ref');
  const id = expectString(datasetRef.id, 'manifest.dataset_ref.id', 512);
  const name = expectString(datasetRef.name, 'manifest.dataset_ref.name', 2048);
  const domain = expectEnum(datasetRef.domain, DOMAIN_TYPES, 'manifest.dataset_ref.domain');
  const sourceSha = expectString(datasetRef.sha256, 'manifest.dataset_ref.sha256', 128);
  if (!/^[0-9a-f]{16,128}$/i.test(sourceSha)) invalidArchive('manifest.dataset_ref.sha256 must be a hexadecimal digest.');
  const declaredRows = expectSafeInteger(datasetRef.rows, 'manifest.dataset_ref.rows', 0, MAX_DATASET_ROWS);

  const columns = validateColumns(manifest.columns);
  const columnNames = new Set(columns.map((column) => column.name));
  const parsedRows = validateDatasetRows(rows, columnNames);
  if (parsedRows.length !== declaredRows) invalidArchive('dataset row count does not match manifest.dataset_ref.rows.');
  const temporal = validateTemporal(manifest.temporal);
  const vsgByTarget = validateVsg(manifest.vsg_by_target, columnNames);
  const tcp = validateTcpConfig(manifest.tcp_config, columnNames);
  const lockedBaselines = validateLockedBaselines(manifest.locked_baselines, columnNames);
  const autoLogs = validateAutoLog(manifest.auto_log);
  const auditLog = validateAuditLog(manifest.audit_log);
  const seed = expectSafeInteger(manifest.seed, 'manifest.seed', 0, Number.MAX_SAFE_INTEGER);

  return {
    dataset: {
      id,
      name,
      domain,
      rows: parsedRows,
      rawRowCount: parsedRows.length,
      sha256: sourceSha,
      columns,
      temporal,
      nonRoutineEvents: [],
      sourceNote: 'Restored from a validated .ebproj archive.',
    },
    vsgByTarget,
    tcp,
    lockedBaselines,
    autoLogs,
    auditLog,
    seed,
  };
}

export async function exportEbprojZipBlob(payload: {
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  lockedBaselines: Record<string, LockedBaseline>;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
}): Promise<Blob> {
  if (payload.dataset.rows.length > MAX_DATASET_ROWS) invalidArchive(`dataset exceeds the ${MAX_DATASET_ROWS}-row export limit.`);
  const zip = new JSZip();
  const rowsBytes = new TextEncoder().encode(JSON.stringify(payload.dataset.rows));
  if (rowsBytes.byteLength > EBPROJ_LIMITS.maxEntryBytes) invalidArchive('dataset rows exceed the export size limit.');
  const rowsSha256 = await sha256Hex(rowsBytes);
  const manifest = {
    schema_version: CURRENT_ARCHIVE_SCHEMA,
    app_version: '5.2.0',
    exported_at: new Date().toISOString(),
    seed: payload.seed,
    dataset_ref: {
      id: payload.dataset.id,
      name: payload.dataset.name,
      domain: payload.dataset.domain,
      sha256: payload.dataset.sha256,
      rows: payload.dataset.rows.length,
    },
    temporal: payload.dataset.temporal,
    columns: payload.dataset.columns,
    vsg_by_target: payload.vsgByTarget,
    tcp_config: payload.tcp,
    locked_baselines: payload.lockedBaselines,
    auto_log: payload.autoLogs,
    audit_log: payload.auditLog,
    entries: {
      'data/dataset_rows.json': {
        size_bytes: rowsBytes.byteLength,
        sha256: rowsSha256,
      },
    },
    credentials_included: false,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  if (manifestBytes.byteLength > EBPROJ_LIMITS.maxManifestBytes) invalidArchive('manifest exceeds the export size limit.');
  validateManifestAndRows(manifest, payload.dataset.rows);
  zip.file('manifest.json', manifestBytes);
  zip.file('data/dataset_rows.json', rowsBytes);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (blob.size > EBPROJ_LIMITS.maxFileBytes) invalidArchive('project archive exceeds the export file size limit.');
  return blob;
}

export async function importEbprojZipFile(file: File): Promise<{
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  lockedBaselines: Record<string, LockedBaseline>;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
}> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) invalidArchive('archive file size is invalid.');
  if (file.size > EBPROJ_LIMITS.maxFileBytes) invalidArchive('archive exceeds the compressed file size limit.');

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    invalidArchive('archive bytes could not be read.');
  }
  if (archiveBytes.byteLength !== file.size || archiveBytes.byteLength > EBPROJ_LIMITS.maxFileBytes) {
    invalidArchive('archive byte length does not match the allowed file size.');
  }

  const metadata = inspectZipArchive(archiveBytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: false, createFolders: false });
  } catch {
    invalidArchive('ZIP structure could not be parsed.');
  }

  const loadedEntries = Object.values(zip.files);
  if (loadedEntries.length !== metadata.entryStats.size) invalidArchive('ZIP entry set changed during parsing.');
  for (const entry of loadedEntries) {
    if (!ALLOWED_ZIP_NAMES.has(entry.name)) invalidArchive(`Unexpected ZIP entry '${entry.name}'.`);
    if (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name) {
      invalidArchive(`ZIP entry '${entry.unsafeOriginalName}' uses an unsafe path.`);
    }
    const stats = metadata.entryStats.get(entry.name);
    if (!stats) invalidArchive(`ZIP entry '${entry.name}' has no validated size record.`);
    if (entry.dir !== entry.name.endsWith('/')) invalidArchive(`ZIP entry '${entry.name}' has an invalid directory flag.`);
    const internalData = (entry as JSZip.JSZipObject & { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    if (!entry.dir && (!internalData || internalData.compressedSize !== stats.compressedSize || internalData.uncompressedSize !== stats.uncompressedSize)) {
      invalidArchive(`ZIP entry '${entry.name}' size metadata changed during parsing.`);
    }
  }

  const manifestEntry = zip.file('manifest.json');
  const rowsEntry = zip.file('data/dataset_rows.json');
  if (!manifestEntry || !rowsEntry) invalidArchive('Required manifest.json or data/dataset_rows.json entry is missing.');

  const manifestBytes = await manifestEntry.async('uint8array');
  if (manifestBytes.byteLength > EBPROJ_LIMITS.maxManifestBytes) invalidArchive('manifest exceeds the size limit.');
  let manifestValue: unknown;
  try {
    const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
    manifestValue = JSON.parse(manifestText);
  } catch {
    invalidArchive('manifest.json is not valid UTF-8 JSON.');
  }
  const manifest = expectRecord(manifestValue, 'manifest.json');
  const isCurrent = manifest.schema_version === CURRENT_ARCHIVE_SCHEMA;
  const isLegacy = manifest.schema_version === LEGACY_ARCHIVE_APP_VERSION && manifest.entries === undefined;
  if (!isCurrent && !isLegacy) invalidArchive(`unsupported schema_version '${String(manifest.schema_version)}'.`);

  const rowsBytes = await rowsEntry.async('uint8array');
  if (rowsBytes.byteLength > EBPROJ_LIMITS.maxEntryBytes) invalidArchive('dataset rows exceed the uncompressed size limit.');
  if (isCurrent) {
    const entries = safeEntries(manifest.entries, 'manifest.entries', 1);
    if (entries.length !== 1 || entries[0][0] !== 'data/dataset_rows.json') {
      invalidArchive('manifest.entries must checksum data/dataset_rows.json only.');
    }
    const checksum = expectRecord(entries[0][1], 'manifest.entries.data/dataset_rows.json');
    const expectedSize = expectSafeInteger(checksum.size_bytes, 'manifest.entries.data/dataset_rows.json.size_bytes', 0, EBPROJ_LIMITS.maxEntryBytes);
    const expectedHash = expectString(checksum.sha256, 'manifest.entries.data/dataset_rows.json.sha256', 64);
    if (!/^[0-9a-f]{64}$/i.test(expectedHash)) invalidArchive('dataset rows checksum must be a SHA-256 hexadecimal digest.');
    if (rowsBytes.byteLength !== expectedSize) invalidArchive('dataset rows byte length does not match its manifest checksum record.');
    const actualHash = await sha256Hex(rowsBytes);
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) invalidArchive('dataset rows SHA-256 checksum mismatch.');
  }

  let parsedRows: unknown;
  try {
    const rowsText = new TextDecoder('utf-8', { fatal: true }).decode(rowsBytes);
    parsedRows = JSON.parse(rowsText);
  } catch {
    invalidArchive('data/dataset_rows.json is not valid UTF-8 JSON.');
  }
  const restored = validateManifestAndRows(manifest, parsedRows);
  const archiveName = typeof file.name === 'string' ? file.name.slice(0, 512) : 'project archive';
  restored.dataset.sourceNote = `Restored from .ebproj (${archiveName}).`;
  return restored;
}
