-- Valid pre-upgrade rows, with every removed table populated.
DO $$
DECLARE
    p text := 'test';
    b uuid := '00000000-0000-0000-0000-000000000001';
    parent uuid := '00000000-0000-0000-0000-000000000002';
    candidate uuid := '00000000-0000-0000-0000-000000000003';
    integration uuid := '00000000-0000-0000-0000-000000000004';
    learned text := 'learn-' || integration;
    proposal uuid := '00000000-0000-0000-0000-000000000005';
    comparison uuid := '00000000-0000-0000-0000-000000000006';
    evaluation uuid := '00000000-0000-0000-0000-000000000007';
    draft uuid := '00000000-0000-0000-0000-000000000008';
    promotion uuid := '00000000-0000-0000-0000-000000000009';
    outcome uuid := '00000000-0000-0000-0000-000000000010';
    correction uuid := '00000000-0000-0000-0000-000000000011';
    round_id_fixture uuid := '00000000-0000-0000-0000-000000000012';
    fixture_authorization bigint;
BEGIN
    INSERT INTO projects(id,name) VALUES (p, 'Upgrade test');
    INSERT INTO bundles(id,project_id,name) VALUES (b,p,'Bundle');
    INSERT INTO proposals(id,project_id,bundle_id,parent_version_id,candidate_version_id,request,status,requested_by)
        VALUES (proposal,p,b,parent,candidate,'{}','succeeded','fixture');
    INSERT INTO versions(id,project_id,bundle_id,parent_version_id,digest,payload,created_by,proposal_id)
        VALUES (parent,p,b,NULL,'parent-digest','{}','fixture',NULL),
               (candidate,p,b,parent,'candidate-digest','{}','fixture',proposal);
    INSERT INTO channels(project_id,bundle_id,name,revision,version_id)
        VALUES (p,b,'stable',1,parent),(p,b,learned,1,candidate);
    INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter)
        VALUES (comparison,p,b,'{}',true,'fixture');
    INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,comparison_id,reviewer)
        VALUES (promotion,p,b,learned,1,candidate,comparison,'fixture');
    INSERT INTO drafts(id,project_id,bundle_id,channel,base_version_id,base_revision,snapshot_version_id,generation,status,created_by)
        VALUES (draft,p,b,'stable',parent,1,candidate,1,'open','fixture');
    INSERT INTO draft_snapshots(project_id,bundle_id,channel,draft_id,generation,version_id)
        VALUES (p,b,'stable',draft,1,candidate);
    INSERT INTO evaluation_policy_receipts(project_id,bundle_id,candidate_version_id,comparison_id,policy_digest,body,reported_by)
        VALUES (p,b,candidate,comparison,'digest','{}','fixture');
    INSERT INTO evaluation_requests(id,project_id,bundle_id,body,requested_by,status)
        VALUES (evaluation,p,b,'{}','service:connected-learning','requested');
    INSERT INTO evaluation_progress(request_id,body) VALUES (evaluation,'{}');

    INSERT INTO integrations(id,project_id,bundle_id,channel,display_name)
        VALUES (integration,p,b,'stable','App');
    INSERT INTO connected_learning_enrollments(project_id,bundle_id,integration_id,source_channel,source_revision,
        delivery_channel,installation_id,permitted_paths,max_proposal_admissions,development,audits,
        automatic_rollout,outcome_principal,evaluator_principal,authorized_by)
        VALUES (p,b,integration,'stable',1,learned,'install',ARRAY['guide.md'],2,'{}','[{}]',
            false,'outcome','evaluator','fixture');
    INSERT INTO connected_learning_policy_epochs(project_id,integration_id,epoch,development)
        VALUES (p,integration,0,'{}');
    INSERT INTO connected_learning_authorizations(project_id,integration_id,principal)
        VALUES (p,integration,'fixture') RETURNING id INTO fixture_authorization;
    INSERT INTO connected_learning_automatic_promotions(promotion_id,authorization_id) VALUES (promotion,fixture_authorization);
    INSERT INTO connected_learning_cohorts(project_id,bundle_id,kind,identity,integration_id,audit_index)
        VALUES (p,b,'audit','fixture',integration,0);
    INSERT INTO connected_learning_renewals(project_id,integration_id,renewal_id,request,revision,authorized_by)
        VALUES (p,integration,outcome,'{}',1,'fixture');
    INSERT INTO connected_learning_outcomes(project_id,integration_id,bundle_id,outcome_id,version_id,digest,status,submitted_by)
        VALUES (p,integration,b,outcome,candidate,'candidate-digest','completed','outcome');
    INSERT INTO connected_learning_corrections(project_id,bundle_id,integration_id,correction_id,outcome_id,lesson,submitted_by)
        VALUES (p,b,integration,correction,outcome,'{}','outcome');
    -- The primary correction trigger also populates connected_learning_round_corrections.
    INSERT INTO connected_learning_rounds(project_id,integration_id,bundle_id,id,outcome_id,parent_version_id,
        parent_revision,proposal_id,state,correction_id,attempt)
        VALUES (p,integration,b,round_id_fixture,outcome,parent,1,proposal,'proposing',correction,1);
    INSERT INTO connected_learning_incumbent_events(project_id,integration_id,policy_epoch,baseline_version_id,
        baseline_revision,source_revision,version_id,chain_length,reason)
        VALUES (p,integration,0,parent,1,1,parent,0,'initial');
    INSERT INTO connected_learning_replay_obligations(project_id,integration_id,bundle_id,version_id,baseline_revision,correction_id)
        VALUES (p,integration,b,parent,1,correction);
    INSERT INTO connected_learning_field_releases(promotion_id,control_version_id) VALUES (promotion,parent);
    INSERT INTO connected_learning_field_verdicts(project_id,integration_id,bundle_id,outcome_id,started_receipt_id,
        verdict,evaluator_principal,promotion_id,control_version_id,grade)
        VALUES (p,integration,b,outcome,outcome,'pass','evaluator',promotion,parent,'pass');
    INSERT INTO connected_learning_field_decisions(promotion_id,kind,control_version_id,verdict_sequences,window_size,losses)
        VALUES (promotion,'validate',parent,ARRAY[1]::bigint[],1,0);

    INSERT INTO durable_commands(project_id,scope,principal_id,key,request,response)
        VALUES (p,'learning/' || integration || '/outcome','outcome','learn','{}','{}'),
               (p,'retained/example','fixture','keep','{}','{}');
    INSERT INTO machine_tokens(id,project_id,principal_id,name,secret_hash,secret_prefix,rights,created_by,expires_at)
        VALUES (outcome,p,'machine:old','Old','old-hash','acm_old',ARRAY['propose'],'fixture',now() + interval '1 day'),
               (correction,p,'machine:read','Reader','read-hash','acm_read',ARRAY['read','propose'],'fixture',now() + interval '1 day');

    INSERT INTO operation_records(principal_id,project_id,namespace,key,path,status)
        SELECT 'fixture',p,route,route,route,'closed'
        FROM unnest(ARRAY[
            format('/v1/workspaces/test/bundles/%s/channels/stable/drafts',b),
            format('/v1/workspaces/test/bundles/%s/evaluation-requests',b),
            format('/v1/workspaces/test/bundles/%s/versions',b)
        ]) route;
    INSERT INTO idempotency(principal_id,project_id,method,path,key,fingerprint,response_status,response_body,expires_at)
        SELECT principal_id,project_id,'POST',path,key,''::bytea,201,'{}'::bytea,now() + interval '1 day'
        FROM operation_records;
    INSERT INTO mutation_audit(project_id,service_principal,principal_id,path,operation_key)
        SELECT project_id,'fixture',principal_id,path,key FROM operation_records;
END
$$;
