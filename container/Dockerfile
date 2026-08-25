# The backup job's machine. Alpine plus the two things the job cannot do without: a real 7-Zip
# for the archives, and Node to drive it.
#
# Nothing is installed for convenience. Every package here is one the job calls by name, and the
# image is small because a backup that takes an extra minute to start is a backup nobody notices.
#
# 备份任务的机器。Alpine 加两样它离不开的东西:打包用的真 7-Zip,以及驱动它的 Node。
#
# 没有一样是"顺手装上"的。这里每个包都是任务按名字调用的;镜像小,是因为一次晚一分钟启动的备份
# 没有人会察觉。
FROM node:22-alpine

RUN apk add --no-cache p7zip

WORKDIR /app
COPY backup.mjs /app/backup.mjs
COPY server.mjs /app/server.mjs

# The container answers on this port; the Worker starts a job and then asks how it is going.
# 容器在这个端口上应答;Worker 发起任务,然后隔一会儿问一次进展。
EXPOSE 8080
ENV WORK_DIR=/work
CMD ["node", "/app/server.mjs"]
