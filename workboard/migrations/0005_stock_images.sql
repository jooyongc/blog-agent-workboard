UPDATE workspace_records SET config_json=json_set(config_json,'$.strategy.required_images',2) WHERE CAST(json_extract(config_json,'$.strategy.required_images') AS INTEGER)<2;
