/*
 * Disclaim launcher and process supervisor for Recapsy's macOS capture process
 * (ADR 0009).
 *
 * Electron cannot set the private `posix_spawn` attribute that makes the
 * capture executable its own TCC responsible process, so Electron starts this
 * launcher in a dedicated POSIX process group. The launcher then posix_spawns
 * the real capture executable with
 * `responsibility_spawnattrs_setdisclaim(attrs, 1)`. The capture process
 * inherits the launcher's dedicated process group while TCC judges it by the
 * stable `one.recapsy.desktop.capture` bundle identity.
 *
 * The two lifecycle layers are intentional:
 *   - SIGTERM / SIGINT sent to the launcher are forwarded to its direct child;
 *   - Electron's forced timeout path sends SIGKILL to the dedicated process
 *     group, because SIGKILL cannot be caught or forwarded by any supervisor.
 *
 * Stdio and the environment are inherited verbatim, preserving the NDJSON
 * channel and RECAPSY_CAPTURE_ASSET_ROOT. The launcher waits for the capture
 * process and mirrors its exit status.
 *
 * argv contract: launcher <capture-executable-absolute-path> [passthrough...]
 */
#include <crt_externs.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Private libSystem API. Not declared in any public SDK header, so we declare
 * the prototype ourselves; the symbol resolves at link time against libSystem.
 */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

/*
 * Only sig_atomic_t state is touched from the handler. `kill(2)` is
 * async-signal-safe; diagnostics and cleanup stay in the normal control flow.
 */
static volatile sig_atomic_t child_process_id = 0;

static void forward_termination_signal(int signal_number) {
    int saved_errno = errno;
    pid_t supervised_child = (pid_t)child_process_id;
    if (supervised_child > 0) {
        (void)kill(supervised_child, signal_number);
    }
    errno = saved_errno;
}

static int install_signal_handler(int signal_number) {
    struct sigaction action;
    action.sa_handler = forward_termination_signal;
    sigemptyset(&action.sa_mask);
    action.sa_flags = 0;
    return sigaction(signal_number, &action, NULL);
}

static void terminate_child(pid_t child_pid) {
    if (child_pid <= 0) {
        return;
    }

    (void)kill(child_pid, SIGKILL);
    while (waitpid(child_pid, NULL, 0) < 0 && errno == EINTR) {
    }
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "capture-launcher: missing capture executable path\n");
        return 64; /* EX_USAGE */
    }

    const char *capture_path = argv[1];
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

    /*
     * Block termination signals until posix_spawn has returned and the handler
     * can see the child PID. The child receives the launcher's previous signal
     * mask and default TERM/INT dispositions through spawn attributes.
     */
    sigset_t termination_signals;
    sigset_t previous_signal_mask;
    sigemptyset(&termination_signals);
    sigaddset(&termination_signals, SIGTERM);
    sigaddset(&termination_signals, SIGINT);
    if (sigprocmask(SIG_BLOCK, &termination_signals, &previous_signal_mask) != 0) {
        fprintf(stderr, "capture-launcher: failed to block termination signals (%d)\n", errno);
        free(child_argv);
        return 71;
    }

    if (install_signal_handler(SIGTERM) != 0 || install_signal_handler(SIGINT) != 0) {
        int handler_errno = errno;
        (void)sigprocmask(SIG_SETMASK, &previous_signal_mask, NULL);
        fprintf(stderr, "capture-launcher: failed to install signal handlers (%d)\n", handler_errno);
        free(child_argv);
        return 71;
    }

    posix_spawnattr_t attrs;
    int rc = posix_spawnattr_init(&attrs);
    if (rc != 0) {
        (void)sigprocmask(SIG_SETMASK, &previous_signal_mask, NULL);
        fprintf(stderr, "capture-launcher: posix_spawnattr_init failed (%d)\n", rc);
        free(child_argv);
        return 71;
    }

    short spawn_flags = POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
    rc = posix_spawnattr_setflags(&attrs, spawn_flags);
    if (rc == 0) {
        rc = posix_spawnattr_setsigmask(&attrs, &previous_signal_mask);
    }
    if (rc == 0) {
        rc = posix_spawnattr_setsigdefault(&attrs, &termination_signals);
    }
    if (rc == 0) {
        rc = responsibility_spawnattrs_setdisclaim(&attrs, 1);
    }
    if (rc != 0) {
        (void)sigprocmask(SIG_SETMASK, &previous_signal_mask, NULL);
        fprintf(stderr, "capture-launcher: spawn attribute setup failed (%d)\n", rc);
        posix_spawnattr_destroy(&attrs);
        free(child_argv);
        return 71;
    }

    char **envp = *_NSGetEnviron();
    pid_t child_pid = 0;
    rc = posix_spawn(&child_pid, capture_path, NULL, &attrs, child_argv, envp);
    posix_spawnattr_destroy(&attrs);
    free(child_argv);

    if (rc != 0) {
        (void)sigprocmask(SIG_SETMASK, &previous_signal_mask, NULL);
        fprintf(stderr, "capture-launcher: posix_spawn failed (%d)\n", rc);
        return 71;
    }

    child_process_id = (sig_atomic_t)child_pid;
    pid_t launcher_process_group = getpgrp();
    pid_t child_process_group = getpgid(child_pid);
    if (launcher_process_group != getpid() || child_process_group != launcher_process_group) {
        terminate_child(child_pid);
        child_process_id = 0;
        (void)sigprocmask(SIG_SETMASK, &previous_signal_mask, NULL);
        fprintf(stderr, "capture-launcher: capture process escaped its controlled group\n");
        return 71;
    }
    if (sigprocmask(SIG_SETMASK, &previous_signal_mask, NULL) != 0) {
        int mask_errno = errno;
        terminate_child(child_pid);
        child_process_id = 0;
        fprintf(stderr, "capture-launcher: failed to restore signal mask (%d)\n", mask_errno);
        return 71;
    }

    int status = 0;
    pid_t wait_result;
    do {
        wait_result = waitpid(child_pid, &status, 0);
    } while (wait_result < 0 && errno == EINTR);

    if (wait_result < 0) {
        int wait_errno = errno;
        terminate_child(child_pid);
        child_process_id = 0;
        fprintf(stderr, "capture-launcher: waitpid failed (%d)\n", wait_errno);
        return 71;
    }

    child_process_id = 0;
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return 1;
}
