export function renderFishCompletionScript(): string {
  return `# fish completion for codex-s
function __codex_s_candidates
    set -l args (commandline -xpc)
    set -l current (commandline -ct)

    if test -n "$current"
        set args $args $current
    end

    cx __complete $args
end

complete -c cx -f
complete -c cx -a '(__codex_s_candidates)'
`;
}
