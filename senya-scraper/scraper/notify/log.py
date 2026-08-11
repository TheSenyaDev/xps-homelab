"""
The default channel: write notifications to the container log.

Always configured, so there is never a silent path — `docker logs senya-scraper`
shows what *would* have been pushed before you set up a real channel. It also
serves as the reference implementation: a channel is this small.
"""

import logging
import os

from .base import Channel

log = logging.getLogger("senya-scraper.notify")


class LogChannel(Channel):
    key = "log"
    label = "Container log"

    def configured(self):
        # Opt-out rather than opt-in: set NOTIFY_LOG=0 to silence it.
        return os.environ.get("NOTIFY_LOG", "1") != "0"

    def send(self, title, body, links):
        log.info("[notify] %s\n%s", title, body)
