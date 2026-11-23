"""Start a disposable real worker for executor and behavior tests."""
import os

from executor.tests.sandbox import docker


def start_worker(cleanup, runner, image, token, internal, concurrency=4):
    volume = docker("volume", "create")
    cleanup(docker, "volume", "rm", volume)
    worker = docker("run", "-d", "--add-host", "host.docker.internal:host-gateway",
        "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", volume + ":/var/lib/acclimate-executor",
        "-e", "ACCLIMATE_PROVIDER_HTTP_HOSTS=host.docker.internal", "-e", "ACCLIMATE_SANDBOX_VOLUME=" + volume, "-e", "ACCLIMATE_EXECUTOR_TOKEN=" + token,
        "-e", f"ACCLIMATE_EXECUTOR_SERVICE=http://host.docker.internal:{internal}",
        "-e", "ACCLIMATE_SANDBOX_RUNTIME=" + os.environ.get("ACCLIMATE_SANDBOX_RUNTIME", "docker"),
        "-e", "ACCLIMATE_EXECUTOR_CONCURRENCY=" + str(concurrency),
        "-e", "ACCLIMATE_RUNNER_IMAGE=" + runner, image)
    # Let any active lease finish removing its sandbox before releasing the volume.
    cleanup(docker, "rm", worker)
    cleanup(docker, "stop", "--time", "60", worker)
