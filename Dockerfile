FROM node:14.15.1
ENV PORT=8008
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY . /usr/src/app/
RUN apt-get update && apt-get install -y cron
ADD ./nmpcron.cron /etc/cron.d/npmcron
RUN chmod 0644 /etc/cron.d/npmcron
RUN crontab /etc/cron.d/npmcron
RUN touch /var/log/cron.log
RUN apt-get install -y vim
RUN touch /tmp/cron.log
RUN crontab -u node /tmp/nmpcron.cron
RUN npm i
RUN npm run build
RUN apt-get update
ENV TZ=America/Asuncion
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone
USER node
EXPOSE 8008
CMD ["npm", "start"]
