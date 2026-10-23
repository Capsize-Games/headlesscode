import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

const dockerfile = readFileSync(path.join(process.cwd(), "docker", "Dockerfile"), "utf8")

const retiredCertificates = [
	"mozilla/emSign_ECC_Root_CA_-_G3.crt",
	"mozilla/Comodo_AAA_Services_root.crt",
	"mozilla/emSign_Root_CA_-_C1.crt",
	"mozilla/emSign_ECC_Root_CA_-_C3.crt",
]

for (const certificate of retiredCertificates) {
	const escapedPath = certificate.replaceAll("/", "\\/")
	assert.ok(
		dockerfile.split("\n").some((line) => line.includes(`-e '/^${escapedPath}$/s/^/!/'`)),
		`Docker build must disable ${certificate}`,
	)
}

assert.match(dockerfile, /update-ca-certificates --fresh/, "disabled roots must be removed from generated trust bundles")
console.log("Docker CA trust policy tests passed")
