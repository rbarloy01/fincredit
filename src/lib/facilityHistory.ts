export const ALL_FACILITIES = 'all';

export type FacilityScopedRecord = {
  transactionId?: string;
};

export function isLegacyFacilityFallback(record: FacilityScopedRecord) {
  return !record.transactionId;
}

export function canUseLegacyFacilityFallback(selectedTransactionId?: string, facilityCount = 0) {
  return !!selectedTransactionId && selectedTransactionId !== ALL_FACILITIES && facilityCount <= 1;
}

export function matchesFacilityFilter(record: FacilityScopedRecord, selectedTransactionId?: string, facilityCount = 0) {
  if (!selectedTransactionId || selectedTransactionId === ALL_FACILITIES) return true;
  return record.transactionId === selectedTransactionId ||
    (isLegacyFacilityFallback(record) && canUseLegacyFacilityFallback(selectedTransactionId, facilityCount));
}

export function facilityDisplayName(transactionName: string, record: FacilityScopedRecord) {
  return record.transactionId ? transactionName || 'Facility sin nombre' : 'General / legacy';
}
