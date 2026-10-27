# Builds all three Spring Boot apps once; each runtime stage copies one jar.
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle gradle
RUN ./gradlew --version --no-daemon -q
COPY apps/ai-backend apps/ai-backend
COPY apps/gateway-mvc apps/gateway-mvc
COPY apps/gateway-webflux apps/gateway-webflux
RUN ./gradlew bootJar --no-daemon -q

FROM eclipse-temurin:21-jre AS runtime
WORKDIR /app
ENV JAVA_TOOL_OPTIONS="-Xms256m -Xmx512m"
ENTRYPOINT ["java", "-jar", "/app/app.jar"]

FROM runtime AS ai-backend
COPY --from=build /src/apps/ai-backend/build/libs/ai-backend-0.0.1-SNAPSHOT.jar /app/app.jar

FROM runtime AS gateway-mvc
COPY --from=build /src/apps/gateway-mvc/build/libs/gateway-mvc-0.0.1-SNAPSHOT.jar /app/app.jar

FROM runtime AS gateway-webflux
COPY --from=build /src/apps/gateway-webflux/build/libs/gateway-webflux-0.0.1-SNAPSHOT.jar /app/app.jar
