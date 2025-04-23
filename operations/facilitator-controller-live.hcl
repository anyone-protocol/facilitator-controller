job "facilitator-controller-live" {
  datacenters = ["ator-fin"]
  type = "service"

  group "facilitator-controller-live-group" {
    count = 2

    update {
      stagger      = "30s"
      max_parallel = 1
      canary       = 1
      auto_revert  = true
      auto_promote = true
    }

    network {
      mode = "bridge"
      port "facilitator-controller-port" {
        to = 3000
        host_network = "wireguard"
      }
      port "redis" {
        host_network = "wireguard"
      }
    }

    task "facilitator-controller-live-service" {
      driver = "docker"
      config {
        image = "ghcr.io/anyone-protocol/facilitator-controller:[[.commit_sha]]"
        force_pull = true
      }

      vault {
        policies = [
          "valid-ator-live",
          "jsonrpc-live-facilitator-controller-eth"
        ]
      }

      template {
        data = <<-EOH
        RELAY_REWARDS_PROCESS_ID="[[ consulKey "smart-contracts/live/relay-rewards-address" ]]"
        FACILITY_CONTRACT_ADDRESS="[[ consulKey "facilitator/sepolia/live/address" ]]"

        {{- range service "validator-live-mongo" }}
          MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/facilitator-controller-live"
        {{- end }}
        {{- range service "facilitator-controller-live-redis" }}
          REDIS_HOSTNAME="{{ .Address }}"
          REDIS_PORT="{{ .Port }}"
        {{- end }}

        {{ $apiKeyPrefix := "api_key_" }}
        {{ $allocIndex := env "NOMAD_ALLOC_INDEX" }}

        {{ with secret "kv/valid-ator/live" }}
          FACILITY_OPERATOR_KEY="{{ .Data.data.FACILITY_OPERATOR_KEY }}"
          EVM_NETWORK="{{ .Data.data.INFURA_NETWORK }}"
        {{ end }}
        {{ with secret "kv/jsonrpc/live/facilitator-controller/infura/eth" }}
          EVM_PRIMARY_WSS="wss://sepolia.infura.io/ws/v3/{{ index .Data.data (print $apiKeyPrefix $allocIndex) }}"
        {{ end }}
        {{ with secret "kv/jsonrpc/live/facilitator-controller/alchemy/eth" }}
          EVM_SECONDARY_WSS="wss://eth-sepolia.g.alchemy.com/v2/{{ index .Data.data (print $apiKeyPrefix $allocIndex) }}"
        {{ end }}
        EOH
        destination = "secrets/file.env"
        env         = true
      }

      env {
        BUMP="1"
        IS_LIVE="true"
        VERSION="[[.commit_sha]]"
        CPU_COUNT="1"
        DO_CLEAN="false"
        FACILITY_CONTRACT_DEPLOYED_BLOCK="6844227"
        IS_LOCAL_LEADER="true"
        CU_URL="https://cu.anyone.permaweb.services"
      }
      
      resources {
        cpu    = 4096
        memory = 8192
      }

      service {
        name = "facilitator-controller-live"
        port = "facilitator-controller-port"
        tags = ["logging"]
        
        check {
          name     = "Live facilitator-controller health check"
          type     = "http"
          path     = "/health"
          interval = "5s"
          timeout  = "10s"
          check_restart {
            limit = 180
            grace = "15s"
          }
        }
      }
    }
  }
}
