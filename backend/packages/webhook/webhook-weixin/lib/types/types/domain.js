export function is_cursor_committable(status) {
    return status === 'injected' || status === 'control_applied' || status === 'failed_terminal';
}
