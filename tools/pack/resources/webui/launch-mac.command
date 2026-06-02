#!/usr/bin/env sh
# Double-click entry. `start` now detaches into the background and returns, so
# keep this Terminal window open long enough to read the printed URL.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$DIR/open-design.sh" start
printf '\n按回车键关闭此窗口（服务已在后台运行，停止请运行 ./open-design.sh stop）… '
read _
