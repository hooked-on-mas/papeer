"""Local map reads and cancellable, deduplicated metadata discovery jobs."""
import threading
from fastapi import APIRouter, Depends, Query
from papeer.core import discovery, map_groups
from sidecar import deps
from sidecar.job_types import JobKind, JobStarted
from sidecar.schemas.discovery import DiscoveryRequest, DiscoveryResult, DiscoverySelection, MapGroupRequest, MapGroupResult
from sidecar.schemas.research import ResearchRecord

router = APIRouter(dependencies=[Depends(deps.verify_token)])
_start_lock = threading.Lock()


@router.get("/api/papers/{paper_id}/discovery", response_model=DiscoveryResult)
def read(paper_id: str, origin: str = Query(default="", max_length=200)):
    return discovery.build(deps.get_library(), paper_id, origin or paper_id)


@router.post("/api/papers/{paper_id}/discovery", response_model=JobStarted)
def start(paper_id: str, body: DiscoveryRequest):
    lib = deps.get_library()
    lib.paper(paper_id)
    origin = body.origin or paper_id
    if not deps.get_settings().paper_discovery_enabled:
        raise ValueError("論文マップの外部情報取得はOFFです。設定から変更できます。")

    def action(cancel, progress, _page_ready):
        return discovery.discover(lib, paper_id, origin, cancel, progress,
                                  enabled=lambda: deps.get_settings().paper_discovery_enabled, force=body.force)

    with _start_lock:
        # The job manager enforces one map job per paper, including simultaneous POSTs.
        return deps.submit_job(JobKind.PAPER_DISCOVERY, action, paper_id)


@router.post("/api/papers/{paper_id}/discovery/selection", response_model=ResearchRecord)
def select(paper_id: str, body: DiscoverySelection):
    return discovery.prepare_record(deps.get_library(), paper_id, body.origin or paper_id, body.node_id)


@router.get("/api/papers/{paper_id}/discovery/groups", response_model=MapGroupResult)
def groups(paper_id: str, origin: str = Query(default="", max_length=200)):
    return map_groups.read(deps.get_library(), paper_id, origin or paper_id, deps.get_settings().for_paper_metadata())


@router.post("/api/papers/{paper_id}/discovery/groups", response_model=JobStarted)
def describe_groups(paper_id: str, body: MapGroupRequest):
    lib = deps.get_library()
    lib.paper(paper_id)
    if sum(len(group) for group in body.groups) > 60 or any(len(group) < 2 or any(len(m) > 200 for m in group) for group in body.groups):
        raise ValueError("グループは図に表示される60論文までを指定してください。")
    if not deps.get_settings().paper_metadata_ai_enabled:
        raise ValueError("論文情報のAI取得はOFFです。設定から変更できます。")
    settings = deps.get_settings().for_paper_metadata()

    def action(cancel, progress, _page_ready):
        if not deps.get_settings().paper_metadata_ai_enabled:
            raise ValueError("論文情報のAI取得はOFFです。")
        return map_groups.describe(lib, paper_id, body.origin or paper_id, body.groups,
                                   deps.provider_for(settings, cancel), progress, body.force)

    with _start_lock:
        return deps.submit_job(JobKind.MAP_GROUPS, action, paper_id)
