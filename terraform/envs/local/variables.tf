variable "localstack_endpoint" {
  description = "URL of the running LocalStack instance. Default matches docker-compose."
  type        = string
  default     = "http://localhost:4566"
}
