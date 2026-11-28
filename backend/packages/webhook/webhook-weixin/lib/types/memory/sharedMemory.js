let suite;
export function set_shared_memory(next) {
    suite = next;
}
export function get_shared_memory() {
    return suite;
}
