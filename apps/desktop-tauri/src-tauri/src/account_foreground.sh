# Report foreground agent changes to the pane without consuming terminal input.
_wcm_tty=$(tty 2>/dev/null)
if [ -t 0 ] && [ -r /proc/$$/stat ]; then
  _wcm_parent=$$
  (
    _wcm_last=
    while IFS= read -r _wcm_stat < "/proc/$_wcm_parent/stat"; do
      set -- ${_wcm_stat##*) }
      _wcm_tool=shell
      if [ -r "/proc/$6/comm" ]; then
        IFS= read -r _wcm_name < "/proc/$6/comm"
        case "$_wcm_name" in
          claude|codex) _wcm_tool=$_wcm_name ;;
          node|bun)
            _wcm_name=$(tr '\000' '\n' < "/proc/$6/cmdline" | sed -n '2p')
            case "${_wcm_name##*/}" in claude|claude.js) _wcm_tool=claude ;; codex|codex.js) _wcm_tool=codex ;; esac ;;
        esac
      fi
      if [ "$_wcm_tool" != "$_wcm_last" ]; then
        printf '\033]776;%s\007' "$_wcm_tool" || break
        _wcm_last=$_wcm_tool
      fi
      sleep 2
    done
  ) </dev/null 2>/dev/null &
elif [ -t 0 ] && ps -t "${_wcm_tty#/dev/}" -o tpgid= >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
  _wcm_parent=$$
  (
    _wcm_last=
    while kill -0 "$_wcm_parent" 2>/dev/null; do
      _wcm_tool=$(ps -t "${_wcm_tty#/dev/}" -o pgid=,tpgid=,comm=,args= 2>/dev/null | awk '
        $1 == $2 {
          for (i=3; i<=5 && i<=NF; i++) {
            p=$i; sub(/^.*\//,"",p)
            if (p=="claude" || p=="codex" || p=="codex.js") { print (p=="codex.js" ? "codex" : p); exit }
            if (i==3 && p!="node" && p!="bun") break
          }
        }')
      _wcm_tool=${_wcm_tool:-shell}
      if [ "$_wcm_tool" != "$_wcm_last" ]; then
        printf '\033]776;%s\007' "$_wcm_tool" || break
        _wcm_last=$_wcm_tool
      fi
      sleep 2
    done
  ) </dev/null 2>/dev/null &
fi
