// The vault unlocked in this page. Leaving web notes for another module stops replication and closes the local
// database, but the passphrase stays in this page's memory (never in storage), so coming back, from a citation in
// Tabularius or the home page, opens the vault again without asking. Locking, switching vault, clearing local data,
// signing out and closing or reloading the page forget it.
let kept: { userId: string; vaultId: string; passphrase: string } | undefined;

export function keepUnlocked(userId: string, vaultId: string, passphrase: string) {
    kept = { userId, vaultId, passphrase };
}
export function unlockedVault(userId: string) {
    return kept?.userId === userId ? kept : undefined;
}
export function forgetUnlocked() {
    kept = undefined;
}
