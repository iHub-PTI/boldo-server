FROM node:lts
ENV PORT=8008
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
COPY . /usr/src/app/
RUN npm i
RUN npm run build
RUN ls
USER node
EXPOSE 8008
CMD ["npm", "start"]
