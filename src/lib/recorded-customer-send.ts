/** Approval/manual follow-up alone never proves a customer message was sent. */
export function hasRecordedCustomerSend(activity: { direction: string; status: string }): boolean {
  return activity.direction === 'outbound' && ['sent_manual', 'sent_api', 'sent', 'replied'].includes(activity.status);
}

/** Legacy auto-sent rows lack sendStatus; an explicit non-send overrides them. */
export function hasRecordedAutomaticSend(log: { status: string; sendStatus?: string }): boolean {
  return log.status === 'auto_sent' && (!log.sendStatus || ['sent', 'sent_by_owner'].includes(log.sendStatus));
}
