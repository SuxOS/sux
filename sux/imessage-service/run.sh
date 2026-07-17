#!/bin/sh
# Launch the standalone iMessage service. launchd (com.sux.imessage) runs this
# at load and restarts it if it dies — see com.sux.imessage.plist.
export PATH="$HOME/Library/Python/3.9/bin:$PATH"
export IMESSAGE_SECRET=$(cat "$HOME/.sux-imessage.secret")
export PORT=8791
# Off by default — flip to 1 only once the send path has been manually
# verified on this machine (osascript + Full Disk Access + Automation grants).
export IMESSAGE_ALLOW_SEND=${IMESSAGE_ALLOW_SEND:-0}
cd "$(dirname "$0")"
exec /usr/bin/python3 imessage_server.py
