job "facilitator-controller-live" {
  datacenters = ["ator-fin"]
  type = "service"
  namespace = "live-protocol"

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
        role = "any1-nomad-workloads-controller"
      }

      identity {
        name = "vault_default"
        aud  = ["any1-infra"]
        ttl  = "1h"
      }

      template {
        data = <<-EOH
        {{ $allocIndex := env "NOMAD_ALLOC_INDEX" }}
        
        {{ with secret "kv/live-protocol/facilitator-controller-live"}}
          FACILITY_OPERATOR_KEY="{{ .Data.data.FACILITY_OPERATOR_KEY_DEPRECATED }}"
          EVM_NETWORK="{{ .Data.data.EVM_NETWORK }}"

          EVM_PRIMARY_WSS="wss://sepolia.infura.io/ws/v3/{{ index .Data.data (print `INFURA_SEPOLIA_API_KEY_` $allocIndex) }}"
          EVM_SECONDARY_WSS="wss://eth-sepolia.g.alchemy.com/v2/{{ index .Data.data (print `ALCHEMY_SEPOLIA_API_KEY_` $allocIndex) }}"
        {{ end }}
        EOH
        destination = "secrets/file.env"
        env         = true
      }

      template {
        data = <<-EOH
        RELAY_REWARDS_PROCESS_ID="[[ consulKey "smart-contracts/live/relay-rewards-address" ]]"
        FACILITY_CONTRACT_ADDRESS="[[ consulKey "facilitator/sepolia/live/address" ]]"

        {{- range service "validator-live-mongo" }}
          MONGO_URI="mongodb://{{ .Address }}:{{ .Port }}/facilitator-controller-live"
        {{- end }}
        {{- range service "facilitator-controller-redis-live" }}
          REDIS_HOSTNAME="{{ .Address }}"
          REDIS_PORT="{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/config.env"
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
        USE_HODLER="false"
        USE_FACILITY="true"
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
