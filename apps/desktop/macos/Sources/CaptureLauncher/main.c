/*
 * Disclaim launcher for the Recapsy macOS capture process (ADR 0009).
 *
 * Electron cannot set the private `posix_spawn` attribute that flips a spawned
 * child's TCC "responsible process" to itself, so Electron spawns THIS tiny
 * launcher instead. The launcher posix_spawns the real capture executable with
 * `responsibility_spawnattrs_setdisclaim(attrs, 1)`, which makes the capture
 * process its own responsible process — TCC then judges screen-recording /
 * accessibility against the capture bundle's own signed identity
 * (`one.recapsy.desktop.capture`) rather than the parent chain's identity.
 * This disclaim behaviour was verified on macOS 15 in the ADR 0009 spike.
 *
 * The launcher deliberately does NOTHING else:
 *   - stdio (fd 0/1/2) is inherited by posix_spawn's default behaviour, so the
 *     capture process talks NDJSON to Electron over the same pipes.
 *   - the environment is passed through verbatim (including
 *     RECAPSY_CAPTURE_ASSET_ROOT).
 *   - it `waitpid`s until the capture process exits and exits with the same
 *     status, so from Electron's point of view the child's lifetime IS the
 *     capture process's lifetime (a launcher that exited immediately would look
 *     like an `unexpectedExit` crash to the spawn client).
 *
 * argv contract:  launcher <capture-executable-absolute-path> [passthrough...]
 * The capture path must be the bundle's `Contents/MacOS/Recapsy` so TCC binds
 * the grant to the capture bundle's Info.plist identity.
 */
#include <spawn.h>
#include <sys/wait.h>
#include <crt_externs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Private libSystem API. Not declared in any public SDK header, so we declare
 * the prototype ourselves; the symbol resolves at link time against libSystem.
 */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "capture-launcher: missing capture executable path\n");
        return 64; /* EX_USAGE */
    }

    const char *capture_path = argv[1];

    /*
     * Child argv: argv[0] = capture executable path, then every passthrough
     * argument the launcher received after the path (argv[2..]).
     */
    int child_argc = argc - 1;
    char **child_argv = (char **)calloc((size_t)child_argc + 1, sizeof(char *));
    if (child_argv == NULL) {
        fprintf(stderr, "capture-launcher: out of memory\n");
        return 71; /* EX_OSERR */
    }
    child_argv[0] = (char *)capture_path;
    for (int i = 2; i < argc; i++) {
        child_argv[i - 1] = argv[i];
    }
    child_argv[child_argc] = NULL;

    posix_spawnattr_t attrs;
    int rc = posix_spawnattr_init(&attrs);
    if (rc != 0) {
        fprintf(stderr, "capture-launcher: posix_spawnattr_init failed (%d)\n", rc);
        free(child_argv);
        return 71;
    }

    rc = responsibility_spawnattrs_setdisclaim(&attrs, 1);
    if (rc != 0) {
        fprintf(stderr, "capture-launcher: setdisclaim failed (%d)\n", rc);
        posix_spawnattr_destroy(&attrs);
        free(child_argv);
        return 71;
    }

    /* Inherit the launcher's own environment verbatim. */
    char **envp = *_NSGetEnviron();

    pid_t child_pid = 0;
    /*
     * No file actions: posix_spawn's default inherits fd 0/1/2, which is exactly
     * the NDJSON stdio channel Electron opened. Absolute path, so posix_spawn
     * (not posix_spawnp) is correct.
     */
    rc = posix_spawn(&child_pid, capture_path, NULL, &attrs, child_argv, envp);
    posix_spawnattr_destroy(&attrs);
    free(child_argv);

    if (rc != 0) {
        fprintf(stderr, "capture-launcher: posix_spawn failed (%d)\n", rc);
        return 71;
    }

    /*
     * Stay alive for the whole lifetime of the capture process and mirror its
     * exit status, so the Electron spawn client never sees a premature exit.
     */
    int status = 0;
    while (waitpid(child_pid, &status, 0) < 0) {
        /* Retry on EINTR; any other error means we lost the child. */
    }

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        /* Convention: 128 + signal number, mirroring shells. */
        return 128 + WTERMSIG(status);
    }
    return 1;
}
