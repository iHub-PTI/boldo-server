FROM node:14.15.1
ENV PORT=8008
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY . /usr/src/app/
# Upload our local files to /tmp in the container:
COPY ./npmcron.* /tmp/
# Install cron as it's not installed by the above image as default:
RUN apt-get update && apt-get install -y cron
# Make the cron script executable, and touch the log file it will be writing to:
RUN chmod +x /tmp/npmcron.sh && touch /tmp/cron.log
# Install our cron job in root user's crontab, using the file we copied over above:
RUN crontab -u root /tmp/npmcron.cron
RUN npm i
RUN npm run build
RUN apt-get update
ENV TZ=America/Asuncion
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
USER node
EXPOSE 8008
CMD ["npm", "start"]
