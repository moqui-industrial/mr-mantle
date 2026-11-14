// Smithy's releases (mr-pass plan/design-smithy.md §13.3, DG7; SmithySite.js): a release is Mantle's release of the
// repository's project linked to a tag; a Maintainer makes it, a draft is Not Found to everyone else, and the notes are
// cleaned; publishing it copies the artifact of the tag's successful pipeline run as an asset with its size and SHA-256;
// an asset downloads for who views the release and is Not Found to a stranger once the repository is private. A spec
// cannot play the runner, so the tag's run is written as the engine keeps one, its artifact's content a stored file whose
// blob id is its SHA-256. Reads SmithyDocs's fixture. Regression suite: these are rules. Run:
// ./moq test mr-mantle --spec SmithyReleases
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const ids = {}
const op = (username, operation, input) => lib.op(username, lib.SITE7, operation, {repositoryId: ids.repositoryId, ...input})
// over the 64 KiB a stored file keeps in its row, so its content is a blob
const ARTIFACT_TEXT = "the release's archive, as a runner uploaded it\n".repeat(2000)

spec({
    dependsOn: ["SmithyDocs"],
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        Object.assign(ids, lib.siteIds())
        const tag = Array.from(
            lib.run("org.moqui.git.GitServices.get#GitRefs", {repositoryId: ids.repositoryId, refType: "tag"}).refList
        ).find(ref => ref.shortName === "v1.2.0")
        // the tag's run as the engine keeps one, with an artifact whose content is a stored blob
        lib.privileged(() =>
            ec.resource.getLocationReference("dbresource://smithy-spec/sst-artifact.tar.gz").putText(ARTIFACT_TEXT)
        )
        const sha256 = ec.resource.digestText(ARTIFACT_TEXT, "sha256")
        const at = ec.user.nowTimestamp
        lib.make("moqui.resource.GitPipelineRun", {
            pipelineRunId: "SST_RUN",
            repositoryId: ids.repositoryId,
            runNum: 1,
            pipelineName: "release",
            event: "tag",
            refName: "refs/tags/v1.2.0",
            commitId: tag.commitId,
            trusted: "Y",
            statusId: "success",
            createdDate: at,
            finishedDate: at
        })
        lib.make("moqui.resource.GitJobRun", {
            jobRunId: "SST_JOB",
            pipelineRunId: "SST_RUN",
            repositoryId: ids.repositoryId,
            jobName: "build",
            attempt: 1,
            statusId: "success",
            queuedDate: at,
            finishedDate: at
        })
        lib.make("moqui.resource.GitRunArtifact", {
            artifactId: "SST_ARTIFACT",
            jobRunId: "SST_JOB",
            pipelineRunId: "SST_RUN",
            repositoryId: ids.repositoryId,
            artifactKind: "artifact",
            name: "dist",
            blobId: sha256,
            sizeBytes: ARTIFACT_TEXT.length,
            sha256,
            createdDate: at
        })
        ids.sha256 = sha256
    }
})

feature("a Maintainer makes a tag's release; a draft is the Maintainer's; publishing takes the tag's run artifact", {
    when() {
        const draft = op("SST_MAINT", "storeRelease", {
            tag: "v1.2.0",
            name: "Spring",
            notes: "# Notes\n\nFixed the widget.<script>alert(3)</script>",
            published: false,
            operationId: "sst-release-1"
        })
        const draftRead = {
            stranger: op(null, "getRelease", {tag: "v1.2.0"}).kind,
            maintainer: op("SST_MAINT", "getRelease", {tag: "v1.2.0"})
        }
        const byStranger = op("SST_STRANGER", "storeRelease", {tag: "v1.2.0", published: true, expectedRevision: draft.revision})
        const noTag = op("SST_MAINT", "storeRelease", {tag: "v9.9.9", operationId: "sst-release-2"})
        const published = op("SST_MAINT", "storeRelease", {tag: "v1.2.0", published: true, expectedRevision: draft.revision})
        const stale = op("SST_MAINT", "storeRelease", {tag: "v1.2.0", name: "Again", expectedRevision: draft.revision})
        return {
            draft,
            draftRead,
            byStranger,
            noTag,
            published,
            stale,
            read: op(null, "getRelease", {tag: "v1.2.0"}),
            listed: lib.op(null, lib.SITE7, "findReleases", {groupId: ids.groupId}),
            release: lib.row("mantle.smithy.SmithyReleaseTag", {repositoryId: ids.repositoryId, refName: "refs/tags/v1.2.0"})
        }
    },
    then({draft, draftRead, byStranger, noTag, published, stale, read, listed, release}) {
        draft.tag == "v1.2.0"
        draft.revision == 1
        draftRead.stranger == "NotFound"
        draftRead.maintainer.release.published == false
        draftRead.maintainer.capabilities.canEdit == true
        byStranger.reason == "accessDenied"
        noTag.kind == "Unprocessable"
        published.revision == 2
        stale.reason == "staleRevision"
        // Mantle's release of the repository's project, named as the tag's version
        release.workEffortTypeEnumId == "WetRelease"
        release.workEffortName == "1.2.0"
        read.release.published == true
        read.release.name == "Spring"
        read.release.notesHtml.includes("Fixed the widget.")
        !read.release.notesHtml.includes("<script")
        read.release.assetList.map(asset => asset.name + ":" + asset.sizeBytes + ":" + asset.sha256).join() ==
            "dist.tar.gz:" + ARTIFACT_TEXT.length + ":" + ids.sha256
        read.archiveList.map(archive => archive.path).join() ==
            "/code/sstgroup/site/-/archive/v1.2.0.zip,/code/sstgroup/site/-/archive/v1.2.0.tar.gz"
        read.component.name == "sst-site"
        listed.releaseList.map(row => row.repositoryPath + "@" + row.tag).join() == "sstgroup/site@v1.2.0"
    }
})

feature("an asset downloads for who views the release, and is Not Found to a stranger when the repository is private", {
    when() {
        const asset = lib.row("mantle.smithy.SmithyReleaseAsset", {repositoryId: ids.repositoryId, name: "dist.tar.gz"})
        const image = op("SST_MAINT", "addReleaseAsset", {
            tag: "v1.2.0",
            imageName: "registry.test/sst/site:1.2.0",
            operationId: "sst-asset-1"
        })
        const taken = op("SST_MAINT", "addReleaseAsset", {
            tag: "v1.2.0",
            name: "dist.tar.gz",
            imageName: "registry.test/x:1",
            operationId: "sst-asset-2"
        })
        const open = op(null, "downloadReleaseAsset", {assetId: asset.assetId})
        lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {visibilityEnumId: "SmvPrivate"})
        let closed, maintainer
        try {
            closed = op("SST_STRANGER", "downloadReleaseAsset", {assetId: asset.assetId})
            maintainer = op("SST_MAINT", "downloadReleaseAsset", {assetId: asset.assetId})
        } finally {
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.repositoryId}, {visibilityEnumId: "SmvPublic"})
        }
        return {
            asset,
            image,
            taken,
            open,
            closed,
            maintainer,
            copied: lib.privileged(() => ec.resource.digest(asset.contentLocation, "sha256"))
        }
    },
    then({asset, image, taken, open, closed, maintainer, copied}) {
        // the row keeps the file's place, never a blob
        asset.contentLocation.includes("/smithy/" + lib.SITE7 + "/release-assets/")
        asset.pipelineRunId == "SST_RUN"
        // the file was copied whole
        copied == ids.sha256
        image.assetId != null
        taken.reason == "nameTaken"
        open.file.filename == "dist.tar.gz"
        open.sha256 == ids.sha256
        closed.kind == "NotFound"
        maintainer.file.filename == "dist.tar.gz"
    }
})
