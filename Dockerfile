FROM rust:bookworm AS builder

WORKDIR /usr/src/moments
COPY ./src/ ./src/
COPY ./Cargo.lock ./Cargo.toml ./

RUN cargo install --path .

FROM debian:bookworm-slim

COPY --from=builder /usr/local/cargo/bin/moments /usr/local/bin/moments
WORKDIR /moments
COPY ./frontend/ ./frontend/

CMD ["moments"]
