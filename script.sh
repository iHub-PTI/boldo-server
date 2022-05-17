#!/bin/bash
touch /tmp/script.log
/usr/local/bin/npm run archiveAppointments >> /tmp/script.log 2>&1
